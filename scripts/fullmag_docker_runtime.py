"""Start verified Fullmag runtime services with managed storage admission.

Live development delegates compilation to the persistent Compose backend.
Packaged release starts retain the frozen assembly contract.
"""
from __future__ import annotations

import argparse
from collections.abc import Mapping
import getpass
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import types
import uuid
from pathlib import Path, PurePosixPath

import fullmag_storage as storage
from local_runner.runtime_use import runtime_package_use, register_runtime_reference_root
from local_runner.worker_entrypoint import verify_source
from run_managed_browser import digest, host_path, read_json, validate_managed_build

PROFILE = "docker-all-gpu"
# ``fullmag`` was the project name emitted by the pre-grouped Compose runner.
# It remains admissible only when an explicitly named, fully validated run is
# being recreated. Fresh starts must use the checkout-derived identity.
LEGACY_COMPOSE_PROJECT = "fullmag"
# Development frontend grace covers both pinned tool probes, the cold pnpm
# install on the Windows bind, and the bounded Next process startup margin.
FRONTEND_DEV_READY_TIMEOUT_SECONDS = 3900
FRONTEND_DEV_DOCKER_CLIENT_TIMEOUT_SECONDS = 3960
# These remain the separate backend/startup-script contract. Static mode keeps
# its short observation window below; it has no development frontend service.
STARTUP_READY_TIMEOUT_SECONDS = 2400
STARTUP_DOCKER_CLIENT_TIMEOUT_SECONDS = 2460
REQUIRED_BINARIES = (
    "fullmag-api", "fullmag-bin", "fullmag-runtime-service",
    "fullmag-api-resource-pool", "fullmag-api-preparation-resource-pool",
    "fullmag-api-accepted-scheduler", "fullmag-api-accepted-fem-preparation-scheduler",
    "fullmag-api-accepted-worker", "fullmag-api-accepted-supervisor",
    "fullmag-api-accepted-fem-preparer", "fullmag-api-accepted-fem-preparation-supervisor",
    "fullmag-api-preparation-retry",
)
TOOLCHAIN_MANIFEST_PATH = "/opt/fullmag-deps/share/fullmag/dependency-versions.json"
TOOLCHAIN_MANIFEST_SCHEMA = "fullmag.docker.fem-gpu-dependencies.v1"
TOOLCHAIN_SOURCE_COMMITS = ("mfem", "libceed", "hypre", "petsc", "slepc")
TOOLCHAIN_PREFLIGHT_TIMEOUT_SECONDS = 60
TOOLCHAIN_MANIFEST_MAX_BYTES = 2 * 1024 * 1024
RUNTIME_CONFIG_RELATIVE = Path(".fullmag/runtime-service/docker-all.json")
RUNTIME_CONFIG_HISTORY_RELATIVE = Path("state") / RUNTIME_CONFIG_RELATIVE
_RUN_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_CONFIG_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{12,64}$")
_DEVELOPMENT_BUILD_SCHEMA = "fullmag.windows-folder-development-build.v1"
_PROVISIONAL_COMMIT = "0" * 40
_PROVISIONAL_DIGEST = "0" * 64
_SOURCE_IDENTITY_FIELDS = (
    "source_project_id", "source_worktree_id", "source_checkout_kind",
)
_SOURCE_LABEL_VALUE_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")
_TOOLCHAIN_MANIFEST_PROBE = r'''
import os
import stat
import sys

path, maximum_text = sys.argv[1:]
maximum = int(maximum_text)
flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
descriptor = os.open(path, flags)
try:
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit("dependency manifest is not a regular file")
    if metadata.st_size <= 0 or metadata.st_size > maximum:
        raise SystemExit("dependency manifest exceeds its bounded size")
    chunks = bytearray()
    while len(chunks) <= maximum:
        chunk = os.read(descriptor, min(64 * 1024, maximum + 1 - len(chunks)))
        if not chunk:
            break
        chunks.extend(chunk)
finally:
    os.close(descriptor)
if len(chunks) > maximum:
    raise SystemExit("dependency manifest exceeds its bounded size")
sys.stdout.buffer.write(chunks)
'''


def _backend_cache_kind(value):
    """Return the explicit backend cache generation and its adapter.

    The v1 ext4/bind profile remains a supported archived-input contract.
    A missing or unknown schema is never treated as either generation.
    """

    if not isinstance(value, dict):
        raise ValueError("Backend cache profile must be an object")
    try:
        import docker_backend_cache as legacy_cache
        import docker_backend_volume_cache as volume_cache
    except ImportError as error:  # pragma: no cover - packaging error
        raise ValueError("Backend cache adapters are unavailable") from error
    schema = value.get("schema")
    if schema == volume_cache.SCHEMA:
        return "v2", volume_cache
    if schema == legacy_cache.SCHEMA:
        return "v1", legacy_cache
    raise ValueError("Backend cache profile has an unsupported schema")


def _read_backend_cache_document(path_value, digest_value, label, *, expected=None,
                                 maximum=4 * 1024 * 1024):
    """Read one host-published cache record and bind it to stable bytes."""

    if not isinstance(path_value, str):
        raise ValueError(f"Backend cache {label} path is missing")
    path = Path(path_value)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError(f"Backend cache {label} is not an immutable regular file")
    if digest_value is not None and (
            not isinstance(digest_value, str)
            or _CONFIG_SHA256_RE.fullmatch(digest_value) is None):
        raise ValueError(f"Backend cache {label} digest is invalid")
    try:
        first = path.read_bytes()
        second = path.read_bytes()
    except OSError as error:
        raise ValueError(f"Backend cache {label} cannot be read") from error
    if first != second or not first or len(first) > maximum:
        raise ValueError(f"Backend cache {label} changed or exceeds its bound")
    if digest_value is not None and hashlib.sha256(first).hexdigest() != digest_value:
        raise ValueError(f"Backend cache {label} digest differs from its receipt")
    try:
        value = json.loads(first)
    except (UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError(f"Backend cache {label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError(f"Backend cache {label} must contain an object")
    if expected is not None and value != expected:
        raise ValueError(f"Backend cache {label} differs from its published descriptor")
    return value


def _validate_backend_volume_cache(value, *, expected_package=None):
    """Validate the v2 named-volume descriptor before Compose or attestation."""

    kind, adapter = _backend_cache_kind(value)
    if kind != "v2":
        return None
    if value.get("profile") != adapter.PROFILE or value.get("state") != "ready":
        raise ValueError("Backend volume cache profile is not ready")
    if value.get("build_root") != adapter.BUILD_TARGET or value.get("mount_root") != adapter.BUILD_TARGET:
        raise ValueError("Backend volume cache build root is not the canonical daemon target")
    if value.get("package_root") != adapter.PACKAGE_TARGET:
        raise ValueError("Backend volume cache package root is not the canonical daemon target")
    if expected_package is not None and expected_package != adapter.PACKAGE_TARGET:
        raise ValueError("Backend start package root differs from the v2 cache target")
    environment = value.get("environment")
    if (not isinstance(environment, dict)
            or environment.get("FULLMAG_BACKEND_PACKAGE") != adapter.PACKAGE_TARGET):
        raise ValueError("Backend volume cache package environment is not typed")
    volume_names = value.get("volume_names")
    if (not isinstance(volume_names, dict)
            or set(volume_names) != {adapter.BUILD_VOLUME_ROLE, adapter.PACKAGE_VOLUME_ROLE}
            or any(not isinstance(name, str) or adapter._VOLUME_NAME.fullmatch(name) is None
                   for name in volume_names.values())):
        raise ValueError("Backend volume cache volume names are invalid")
    if value.get("mounts") != adapter.mount_specs(value):
        raise ValueError("Backend volume cache mounts are not the canonical named-volume pair")
    receipt_expected = value.get("receipt")
    if not isinstance(receipt_expected, dict):
        raise ValueError("Backend volume cache ready receipt is missing")
    receipt = _read_backend_cache_document(
        value.get("receipt_path"), value.get("receipt_sha256"), "ready receipt",
        expected=receipt_expected, maximum=16 * 1024 * 1024,
    )
    if receipt.get("schema") != adapter.SCHEMA or receipt.get("profile") != adapter.PROFILE:
        raise ValueError("Backend volume cache ready receipt schema differs")
    if (receipt.get("volume_names") != volume_names
            or receipt.get("build_root") != adapter.BUILD_TARGET
            or receipt.get("package_root") != adapter.PACKAGE_TARGET
            or receipt.get("mounts") != value["mounts"]):
        raise ValueError("Backend volume cache ready receipt volume identity differs")
    try:
        adapter._validate_volume_documents(value["volume_documents"], value)
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"Backend volume cache volume receipt is invalid: {error}") from error
    if environment != adapter._cache_environment(value):
        raise ValueError("Backend volume cache environment is not canonical")
    overlay_expected = value.get("overlay")
    if not isinstance(overlay_expected, dict):
        raise ValueError("Backend volume cache Compose overlay descriptor is missing")
    overlay = _read_backend_cache_document(
        value.get("compose_overlay"), value.get("compose_overlay_sha256"),
        "Compose overlay", expected=overlay_expected,
    )
    maintenance_expected = value.get("maintenance_overlay")
    if not isinstance(maintenance_expected, dict):
        raise ValueError("Backend volume cache maintenance overlay descriptor is missing")
    maintenance_path = value.get("maintenance_compose_overlay")
    if maintenance_path is None:
        # Keep the field name explicit for callers that materialize the path
        # before the host wrapper adds its compatibility alias.
        maintenance_path = value.get("maintenance_overlay_path")
    maintenance_overlay = _read_backend_cache_document(
        maintenance_path,
        value.get("maintenance_compose_overlay_sha256", value.get("maintenance_overlay_sha256")),
        "maintenance overlay", expected=maintenance_expected,
    )
    try:
        if overlay != adapter.overlay(value) or maintenance_overlay != adapter.maintenance_overlay(value):
            raise ValueError("cache overlay differs from the canonical adapter output")
        adapter.validate_overlay(overlay, value)
        adapter.validate_maintenance_overlay(maintenance_overlay, value)
    except Exception as error:
        raise ValueError(f"Backend volume cache overlay validation failed: {error}") from error
    return adapter


def validate_runtime_artifacts(package, *, development=False):
    web = () if development else ("web/index.html",)
    for relative in (*("bin/" + name for name in REQUIRED_BINARIES),
                     *web, "_fullmag_core.so"):
        if not (package / relative).is_file():
            raise ValueError(f"Missing runtime artifact: {relative}")


def _validate_toolchain_manifest(value):
    if not isinstance(value, dict):
        raise ValueError("Configured FEM/GPU image returned a non-object dependency manifest")
    if value.get("schema") != TOOLCHAIN_MANIFEST_SCHEMA:
        raise ValueError("Configured FEM/GPU image has an unsupported dependency manifest schema")
    for field in ("declared", "actual", "latest"):
        if field not in value or not isinstance(value[field], dict):
            raise ValueError(f"Configured FEM/GPU dependency manifest is missing object field: {field}")
    actual = value["actual"]
    commits = actual.get("source_commits")
    if not isinstance(commits, dict):
        raise ValueError("Configured FEM/GPU dependency manifest has no actual.source_commits object")
    missing = [
        name for name in TOOLCHAIN_SOURCE_COMMITS
        if not isinstance(commits.get(name), str) or not commits[name].strip()
    ]
    if missing:
        raise ValueError(
            "Configured FEM/GPU dependency manifest has missing source commits: "
            + ", ".join(missing)
        )
    return value


def _preflight_toolchain_image(image):
    """Read and validate the runtime dependency manifest from one pinned image."""

    if not isinstance(image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("Configured fem-gpu-release image must be a full immutable SHA-256 ID")
    command = [
        "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--user", "65532:65532",
        "--pids-limit", "16", "--memory", "64m", "--cpus", "0.25",
        "--entrypoint", "/usr/local/bin/python3", image, "-c",
        _TOOLCHAIN_MANIFEST_PROBE, TOOLCHAIN_MANIFEST_PATH, str(TOOLCHAIN_MANIFEST_MAX_BYTES),
    ]
    try:
        raw = docker(*command, timeout=TOOLCHAIN_PREFLIGHT_TIMEOUT_SECONDS)
    except DockerOutcomeUnknown:
        raise
    except Exception as error:
        raise ValueError(
            "Configured fem-gpu-release image failed the dependency manifest preflight"
        ) from error
    if not isinstance(raw, str) or len(raw.encode("utf-8", "replace")) > TOOLCHAIN_MANIFEST_MAX_BYTES:
        raise ValueError("Configured FEM/GPU dependency manifest exceeds its bounded output size")
    try:
        manifest = json.loads(raw)
    except (TypeError, UnicodeError, ValueError) as error:
        raise ValueError("Configured FEM/GPU image returned invalid dependency manifest JSON") from error
    return _validate_toolchain_manifest(manifest)


class DockerOutcomeUnknown(RuntimeError):
    def __init__(self, args, timeout):
        super().__init__(f"Docker client timed out after {timeout}s; container/build outcome is unconfirmed")
        self.operation = list(args)
        self.timeout_seconds = timeout


class StartupOutcomeUnknown(RuntimeError):
    """The container remained owned but did not publish startup activation."""

    def __init__(self, request_id, timeout):
        super().__init__(f"Startup activation {request_id!r} did not reach a durable ready receipt within {timeout}s")
        self.operation = ["startup-activation", request_id]
        self.timeout_seconds = timeout


class StartupScriptRejected(RuntimeError):
    """The script failed validation while its owning runtime remains ready."""

    def __init__(self, activation):
        self.activation = activation
        self.operation = ["startup-activation", activation["request_id"]]
        detail = activation["rejection"]
        super().__init__(f"Startup script rejected; runtime remains ready: {detail['message']}")


class StartupActivationOutcomeUnknown(RuntimeError):
    """The API outcome is unknown after a durable started marker was published."""

    def __init__(self, diagnostic):
        self.diagnostic = dict(diagnostic)
        request_id = self.diagnostic["request_id"]
        self.operation = ["startup-activation", request_id]
        super().__init__(
            f"Startup activation {request_id!r} has an unknown outcome: "
            f"{self.diagnostic['error']}"
        )


def _startup_process_receipt_path(state):
    return Path(state) / ".fullmag/runtime-service/process-tree.json"


def _validate_startup_process_receipt(value, authorization=None, startup_helper=None):
    if not isinstance(value, dict) or value.get("schema") != "fullmag.docker-process-tree.v1":
        raise ValueError("Runtime process-tree receipt schema mismatch")
    if value.get("state") != "ready":
        raise ValueError("Runtime process-tree receipt is not ready")
    if authorization is None:
        return value
    activation = value.get("startup_activation")
    if not isinstance(activation, dict):
        raise ValueError("Runtime process-tree receipt has no startup activation")
    diagnostic_schema = (
        getattr(startup_helper, "STARTUP_ACTIVATION_DIAGNOSTIC_SCHEMA", None)
        if startup_helper is not None
        else None
    )
    if (
        isinstance(diagnostic_schema, str)
        and diagnostic_schema
        and activation.get("schema") == diagnostic_schema
    ):
        if (
            activation.get("state") != "unknown"
            or activation.get("durable_state") != "started"
            or not isinstance(activation.get("request_id"), str)
            or activation.get("request_id") != authorization.get("request_id")
            or not isinstance(activation.get("source_sha256"), str)
            or activation.get("source_sha256") != authorization.get("source_sha256")
            or not isinstance(activation.get("source_relative"), str)
            or activation.get("source_relative") != authorization.get("source_relative")
            or not isinstance(activation.get("error"), str)
            or not activation["error"].strip()
            or len(activation["error"]) > 4096
            or "response" in activation
        ):
            raise ValueError("Runtime startup activation diagnostic fence differs from the host authorization")
        raise StartupActivationOutcomeUnknown(activation)
    if activation.get("state") == "rejected":
        if startup_helper is None:
            raise ValueError("Startup rejection validation requires the attested helper module")
        rejection = startup_helper.validate_rejection_receipt(activation, authorization)
        raise StartupScriptRejected(rejection)
    if (activation.get("schema") != "fullmag.startup-script-activation.v1"
            or activation.get("state") != "activated"
            or activation.get("request_id") != authorization.get("request_id")
            or activation.get("source_sha256") != authorization.get("source_sha256")
            or activation.get("source_relative") != authorization.get("source_relative")):
        raise ValueError("Runtime startup activation fence differs from the host authorization")
    response = activation.get("response")
    if not isinstance(response, dict):
        raise ValueError("Runtime startup activation response is missing")
    # Reuse the exact request/response contract; this does not create a second
    # endpoint or relax the API's live-v2 execution policy.
    if startup_helper is None:
        raise ValueError("Startup receipt validation requires the attested helper module")
    startup_helper.validate_activation_response(response, authorization)
    return value


def _wait_for_startup_ready(state, authorization=None, *, startup_helper=None, timeout=90):
    if timeout <= 0:
        raise ValueError("Startup activation observation timeout must be positive")
    path = _startup_process_receipt_path(state)
    deadline = time.monotonic() + timeout
    while True:
        if path.exists():
            value = read_json(path)
            if value.get("state") in {"failed_outcome_retained", "shutdown_unknown"}:
                raise ValueError("Runtime process-tree receipt records an unconfirmed startup outcome")
            if value.get("state") == "ready":
                return _validate_startup_process_receipt(value, authorization, startup_helper)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            request_id = authorization.get("request_id") if authorization is not None else "runtime-ready"
            raise StartupOutcomeUnknown(request_id, timeout)
        time.sleep(min(0.25, remaining))


def _runtime_ready_timeouts(inputs, startup):
    """Return bounded wait/client budgets for the actual startup contract."""

    if inputs is not None:
        return FRONTEND_DEV_READY_TIMEOUT_SECONDS, FRONTEND_DEV_DOCKER_CLIENT_TIMEOUT_SECONDS
    if startup is not None:
        return STARTUP_READY_TIMEOUT_SECONDS, STARTUP_DOCKER_CLIENT_TIMEOUT_SECONDS
    return 90, 150


def docker(*args, combined=False, timeout=60, environment=None):
    # Windows talks directly to Desktop; Linux uses its active Linux socket.
    command = ["docker"]
    if os.name == "nt":
        command += ["--context", "desktop-linux"]
    try:
        result = subprocess.run([*command, *args], text=True, capture_output=True, timeout=timeout,
                                env=None if environment is None else {**os.environ, **environment})
    except subprocess.TimeoutExpired as error:
        # Only the client is bounded. Docker-managed resources may still exist;
        # callers retain evidence and must not infer failure or retry mutation.
        raise DockerOutcomeUnknown(args, timeout) from error
    if result.returncode:
        raise ValueError(result.stderr.strip() or result.stdout.strip() or "Docker operation failed")
    return (result.stdout + result.stderr if combined else result.stdout).strip()


def _published_host_port_conflicts(document, port):
    host = document.get("HostConfig") if isinstance(document, dict) else None
    bindings = host.get("PortBindings") if isinstance(host, dict) else None
    if not isinstance(bindings, dict):
        return False
    for entries in bindings.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict) or str(entry.get("HostPort", "")) != str(port):
                continue
            host_ip = str(entry.get("HostIp") or "")
            if host_ip in {"", "0.0.0.0", "::", "[::]", "127.0.0.1", "::1", "[::1]"}:
                return True
    return False


def _windows_loopback_port_conflicts(port):
    """Inspect native Windows listeners; fail closed if the probe is unavailable."""

    if os.name != "nt":
        return []
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
    if not system_root:
        raise ValueError("Could not inspect native Windows loopback port ownership: SystemRoot is unset")
    powershell = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    command = [
        str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        (
            "$ErrorActionPreference='Stop'; "
            "@(Get-NetTCPConnection -State Listen "
            "| Where-Object { $_.LocalPort -eq "
            + str(port)
            + " } | Select-Object LocalAddress,LocalPort,OwningProcess,@{Name='State';Expression={[string]$_.State}} "
            + " | ConvertTo-Json -Compress)"
        ),
    ]
    try:
        result = subprocess.run(
            command, text=True, capture_output=True, timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise ValueError(
            "Could not inspect native Windows loopback port ownership"
        ) from error
    if result.returncode:
        detail = (result.stderr or result.stdout or "").strip()
        raise ValueError(
            "Could not inspect native Windows loopback port ownership: " + detail
        )
    raw = result.stdout.strip()
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("Native Windows loopback port probe returned invalid JSON") from error
    records = value if isinstance(value, list) else [value] if isinstance(value, dict) else None
    if records is None or any(not isinstance(record, dict) for record in records):
        raise ValueError("Native Windows loopback port probe returned an invalid record")
    wildcard_addresses = {
        "", "*", "0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0",
        "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1",
    }
    conflicts = []
    for record in records:
        if str(record.get("State", "")).lower() != "listen":
            continue
        address = str(record.get("LocalAddress") or "").strip().lower()
        if address not in wildcard_addresses:
            continue
        conflicts.append(
            f"Windows PID {record.get('OwningProcess', '<unknown>')} ({address or '<any>'})"
        )
    return conflicts


def assert_loopback_port_available(port, project):
    """Reject host listeners before any runtime state mutation."""

    if not 1024 <= port <= 65535:
        raise ValueError("Port must be between 1024 and 65535")
    if not isinstance(project, str) or re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project) is None:
        raise ValueError("Invalid Compose project name")
    native_conflicts = _windows_loopback_port_conflicts(port)
    if native_conflicts:
        raise ValueError(
            f"Requested loopback port {port} is already bound by native Windows: "
            + ", ".join(native_conflicts)
        )
    running_ids = [value for value in docker("ps", "--quiet").splitlines() if value.strip()]
    if not running_ids:
        return
    try:
        documents = json.loads(docker("inspect", *running_ids))
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("Could not inspect running Docker containers for port ownership") from error
    if not isinstance(documents, list):
        raise ValueError("Docker container port inspection returned an invalid document")
    conflicts = []
    for document in documents:
        if not isinstance(document, dict) or not _published_host_port_conflicts(document, port):
            continue
        labels = document.get("Config", {}).get("Labels") if isinstance(document.get("Config"), dict) else {}
        name = str(document.get("Name") or "<unknown>").lstrip("/")
        owner = labels.get("com.docker.compose.project", "unknown") if isinstance(labels, dict) else "unknown"
        conflicts.append(f"{name} (project {owner})")
    if conflicts:
        raise ValueError(
            f"Requested loopback port {port} is already bound by Docker: "
            + ", ".join(conflicts)
        )


def image_id(value):
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError("A full immutable image ID is required")
    observed = json.loads(docker("image", "inspect", value))[0]
    if observed["Id"] != value or observed.get("Config", {}).get("Volumes"):
        raise ValueError("Image identity mismatch or implicit anonymous volumes")
    return observed


def validate_workspace_environment(config):
    environment = dict(value.split("=", 1) for value in config.get("Env", []) if "=" in value)
    if (any(name in environment for name in ("FULLMAG_FDM_EXECUTION", "FULLMAG_FEM_EXECUTION"))
            or environment.get("FULLMAG_FEM_REQUIRE_GPU", "0") != "0"
            or environment.get("FULLMAG_FEM_ALL_IN_GPU", "0") != "0"
            or environment.get("FULLMAG_FEM_MFEM_DEVICE", "") != ""):
        raise ValueError("Runtime toolchain environment overrides model execution intent")


def _compose_source_environment(project, source_identity):
    from docker_compose_identity import compose_network_name, source_labels

    expected_network = compose_network_name(project)
    if source_identity is None:
        return {
            "FULLMAG_COMPOSE_PROJECT": project,
            "FULLMAG_COMPOSE_NETWORK": expected_network,
            "FULLMAG_SOURCE_PROJECT_ID": "unknown",
            "FULLMAG_SOURCE_WORKTREE_ID": "unknown",
            "FULLMAG_SOURCE_CHECKOUT_KIND": "unknown",
        }

    labels = source_labels(source_identity)
    if labels["org.fullmag.compose.project"] != project:
        raise ValueError("Compose project does not match the selected source checkout")
    network_name = source_identity.get("network_name")
    if network_name != expected_network:
        raise ValueError("Compose network does not match the selected source checkout")
    return {
        "FULLMAG_COMPOSE_PROJECT": project,
        "FULLMAG_COMPOSE_NETWORK": network_name,
        "FULLMAG_SOURCE_PROJECT_ID": labels["org.fullmag.source.project-id"],
        "FULLMAG_SOURCE_WORKTREE_ID": labels["org.fullmag.source.worktree-id"],
        "FULLMAG_SOURCE_CHECKOUT_KIND": labels["org.fullmag.source.checkout-kind"],
    }


def _workspace_user_data_root(layout, project):
    """Create the durable user-data namespace for one validated Compose group."""

    if not isinstance(project, str) or re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project) is None:
        raise ValueError("Invalid Compose project name for workspace user data")
    storage_root = storage.validate_path(
        Path(layout["storage_root"]), Path(layout["storage_root"]), "storage root"
    )
    candidate = storage.validate_path(
        storage_root / "user-data" / project, storage_root, "workspace user-data root"
    )
    candidate.mkdir(parents=True, exist_ok=True)
    # Revalidate after creation so a concurrent junction/symlink substitution is
    # rejected before the host path is handed to Docker Desktop.
    return storage.validate_path(candidate, storage_root, "workspace user-data root")


def compose_spec(image, state, port, host_certificate=None, *, repo=None, inputs=None,
                 inputs_path=None, package=None, provenance=None, toolchain_image=None,
                 project="fullmag-config-check", source_identity=None, workspace_state_root=None,
                 template=None, host_ledger=None, startup=None, frontend_cache=None,
                 previous_config_sha256=None, recovery=None, backend_start=None):
    """Resolve the versioned Compose definition; do not generate service topology."""
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("A full immutable image ID is required")
    if not 1024 <= port <= 65535:
        raise ValueError("Port must be between 1024 and 65535")
    if host_certificate is None:
        raise ValueError("Windows host certificate is required")
    if workspace_state_root is None:
        raise ValueError("Durable workspace user-data host root is required")
    workspace_state_root = Path(workspace_state_root)
    if not workspace_state_root.is_absolute():
        raise ValueError("Durable workspace user-data host root must be absolute")
    repo = Path(repo or Path(__file__).resolve().parents[1])
    template = Path(template) if template is not None else repo / ("compose.dev.yaml" if inputs is not None else "compose.static.yaml")
    environment = {
        **_compose_source_environment(project, source_identity),
        "FULLMAG_RELEASE_IMAGE": image, "FULLMAG_DEV_IMAGE": image,
        "FULLMAG_TOOLCHAIN_IMAGE": toolchain_image or image,
        "FULLMAG_TOOLCHAIN_IMAGE_ID": toolchain_image or image,
        "FULLMAG_STATE_ROOT": str(state), "FULLMAG_HTTP_PORT": str(port),
        "FULLMAG_WORKSPACE_STATE_ROOT": str(workspace_state_root),
        "FULLMAG_HOST_CERTIFICATE": str(host_certificate),
        "FULLMAG_BACKEND_HOSTNAME": "fullmag-" + state.parent.name,
    }
    if previous_config_sha256 is not None:
        if _CONFIG_SHA256_RE.fullmatch(str(previous_config_sha256)) is None:
            raise ValueError("Previous runtime configuration digest must be a lowercase SHA-256")
        environment["FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256"] = str(previous_config_sha256)
    if inputs is not None or backend_start is not None:
        if package is None or provenance is None or inputs_path is None:
            raise ValueError("Development Compose requires a managed package and provenance")
        if backend_start is not None:
            if not isinstance(backend_start, Mapping):
                raise ValueError("Backend start inputs must be an object")
            source_root = backend_start.get("source_root")
            source_manifest = backend_start.get("source_manifest")
            git_common = backend_start.get("git_common_dir")
            if not all(isinstance(value, str) and value for value in (source_root, git_common)):
                raise ValueError("Backend start inputs have incomplete source mounts")
            environment.update(
                FULLMAG_SOURCE_ROOT=source_root,
                FULLMAG_SOURCE_GIT_COMMON=git_common,
                FULLMAG_BACKEND_PACKAGE=str(package),
                FULLMAG_PACKAGE_PROVENANCE=str(provenance),
                FULLMAG_DEVELOPMENT_INPUTS=str(inputs_path),
                # The backend worker remains PID 1 until the host publishes
                # the post-build certificate.  This fence prevents a stale
                # certificate from admitting an old package on restart.
                FULLMAG_BACKEND_BUILD_GATE="1",
                FULLMAG_BACKEND_BUILD_RECEIPT="/opt/fullmag/package/backend-build-receipt.json",
                FULLMAG_BACKEND_PROVENANCE="/opt/fullmag/provenance.json",
            )
            # A live start captures the mounted checkout inside backend_dev.
            # Keep this optional solely for older archived Compose metadata;
            # normal fresh starts must not bind a host-created manifest.
            if isinstance(source_manifest, str) and source_manifest:
                environment["FULLMAG_BACKEND_SOURCE_MANIFEST"] = source_manifest
        else:
            environment.update(FULLMAG_SOURCE_ROOT=str(inputs["source_root"]),
                               FULLMAG_BACKEND_PACKAGE=str(package),
                               FULLMAG_PACKAGE_PROVENANCE=str(provenance),
                               FULLMAG_DEVELOPMENT_INPUTS=str(inputs_path))
    definitions = ["-f", str(template)]
    if host_ledger is not None:
        environment.update(host_ledger["environment"])
        definitions.extend(["-f", host_ledger["compose_overlay"]])
    if frontend_cache is not None:
        if inputs is None and backend_start is None:
            raise ValueError("Frontend cache requires development inputs")
        overlay = frontend_cache.get("compose_overlay")
        cache_environment = frontend_cache.get("environment")
        if not isinstance(overlay, str) or not Path(overlay).is_file():
            raise ValueError("Frontend cache Compose overlay is missing")
        if not isinstance(cache_environment, dict):
            raise ValueError("Frontend cache has no resolved Compose environment")
        if not cache_environment.get("FULLMAG_FRONTEND_CACHE_FILESYSTEM_UUID"):
            raise ValueError("Frontend cache has no attested ext4 UUID")
        environment.update(cache_environment)
        definitions.extend(["-f", overlay])
    if backend_start is not None:
        backend_cache = backend_start.get("backend_cache")
        if not isinstance(backend_cache, dict) or backend_cache.get("state") != "ready":
            raise ValueError("Backend start has no ready backend cache profile")
        cache_kind, _cache_adapter = _backend_cache_kind(backend_cache)
        if cache_kind == "v2":
            _validate_backend_volume_cache(
                backend_cache, expected_package=backend_start.get("package_root")
            )
        cache_overlay = backend_cache.get("compose_overlay")
        cache_environment = backend_cache.get("environment")
        if (not isinstance(cache_overlay, str) or not Path(cache_overlay).is_file()
                or not isinstance(cache_environment, dict)):
            raise ValueError("Backend start cache overlay or environment is missing")
        if (cache_environment.get("FULLMAG_BACKEND_PACKAGE")
                != backend_start.get("package_root")):
            raise ValueError("Backend start cache package environment differs from its descriptor")
        environment.update({str(key): str(value) for key, value in cache_environment.items()})
        definitions.extend(["-f", cache_overlay])
    if startup is not None:
        overlay = startup.get("compose_overlay")
        if not isinstance(overlay, str) or not Path(overlay).is_file():
            raise ValueError("Startup script Compose overlay is missing")
        definitions.extend(["-f", overlay])
    if recovery is not None:
        overlay = recovery.get("compose_overlay")
        if not isinstance(overlay, str) or not Path(overlay).is_file():
            raise ValueError("Runtime recovery Compose overlay is missing")
        definitions.extend(["-f", overlay])
    configured = json.loads(docker("compose", "--project-name", project,
                                   "--project-directory", str(repo), *definitions,
                                   "config", "--format", "json", environment=environment))
    if previous_config_sha256 is not None:
        backend = configured.get("services", {}).get("backend")
        if not isinstance(backend, dict):
            raise ValueError("Versioned Compose has no backend service for config rotation")
        backend_environment = backend.setdefault("environment", {})
        if not isinstance(backend_environment, dict):
            raise ValueError("Versioned Compose backend environment is not an object")
        backend_environment["FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256"] = str(previous_config_sha256)
    if host_ledger is not None:
        configured.get("services", {}).pop("host-ledger-maintenance", None)
    if frontend_cache is not None:
        configured.get("services", {}).pop("frontend-cache-maintenance", None)
    expected = {"backend", "frontend"} if (inputs is not None or backend_start is not None) else {"backend"}
    if set(configured.get("services", {})) != expected:
        raise ValueError("Versioned Compose has unexpected services")
    # A running configuration pins an existing image and never triggers a build.
    # Keep the original YAML beside it for review and future image preparation.
    for service in configured["services"].values():
        service.pop("build", None)
    return configured


def prepare_gpu_release(layout, job_id, commit, *, source_digest=None, native_snapshot_sha256=None):
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise ValueError("A full managed job ID is required")
    root = storage.validate_path(Path(layout["runs_root"]) / job_id, Path(layout["storage_root"]))
    context, built = validate_managed_build(root, commit, expected_profile="fem-gpu-release",
                                            source_digest=source_digest, native_snapshot_sha256=native_snapshot_sha256)
    mounts = [m for m in read_json(root / "receipt.json").get("mounts", [])
              if len(m) == 4 and m[0] == "bind" and m[2] == "/source" and m[3] is False]
    if len(mounts) != 1:
        raise ValueError("Managed source capsule mount missing or ambiguous")
    capsule = storage.validate_path(host_path(mounts[0][1]), Path(layout["storage_root"]))
    manifest = verify_source(capsule, context["source_digest"])
    mode = "snapshot" if source_digest is not None else "commit"
    if manifest.get("resolved_commit") != commit or manifest.get("source_mode") != mode:
        raise ValueError("Managed source selection differs from the requested image identity")
    package = storage.validate_path(root / "artifacts/outputs/.fullmag/local", root)
    validate_runtime_artifacts(package)
    image_id(context["image_digest"])
    return root, context, built, capsule, package


def submit_build(repo, commit=None, *, development=False, source_root=None):
    if not development and not re.fullmatch(r"[0-9a-f]{40}", commit or ""):
        raise ValueError("A full commit SHA is required")
    from local_runner.build_executor import configured_build
    from local_runner.build_source import native_identity, bind_identity
    from local_runner.container_client import request
    from local_runner.source import capture_source

    if development:
        from docker_development_inputs import select_checkout
        source_repo = select_checkout(repo, source_root)
        required_helpers = ("Dockerfile", "Dockerfile.dev", "entrypoint.py", "windows_folder_probe.py",
                            "runtime_service.py", "frontend_dev.py", "healthcheck.py")
        for name in required_helpers:
            relative = "docker/all-in-one/" + name
            if storage.git(source_repo, "ls-files", "--", relative) != relative:
                raise ValueError("Integrate the Docker runtime into the selected checkout before its backend snapshot build")
        for relative in ("scripts/docker_startup_script.py", "scripts/fullmag_storage.py"):
            if storage.git(source_repo, "ls-files", "--", relative) != relative:
                raise ValueError("Integrate the pinned Docker startup helper dependencies into the selected checkout before its backend snapshot build")
        mode = "snapshot"
    else:
        source_repo = repo
        mode = "commit"
    # The canonical runner binds origin_repo to the registered worktree.
    # A main-checkout snapshot must use the main layout and registration too.
    layout = storage.resolve_layout(source_repo, PROFILE)
    owner = getpass.getuser()
    configured = configured_build(layout, owner, "fem-gpu-release")
    if not isinstance(configured, dict):
        raise ValueError("Configured fem-gpu-release build profile is not an object")
    _preflight_toolchain_image(configured.get("image_digest"))
    health = request(layout, owner=owner, method="GET", path="/health")
    if health.get("accepting_jobs") is not True or "fem-gpu-release" not in health.get("allowed_profiles", []):
        raise ValueError("The existing runner is not accepting the GPU release profile")
    registration_path = storage.validate_path(Path(layout["storage_root"]) / "index" / (layout["worktree_id"] + ".json"),
                                              Path(layout["storage_root"]))
    registration = read_json(registration_path)
    if registration.get("worktree_id") != layout["worktree_id"] or Path(registration.get("repo_root", "")) != Path(layout["repo_root"]):
        raise ValueError("The source worktree must be registered before build submission")
    storage.initialize(layout)
    capture_id = uuid.uuid4().hex
    destination = storage.validate_path(Path(layout["runs_root"]) / capture_id / "source",
                                        Path(layout["storage_root"]))
    with storage.build_lock(layout):
        destination.mkdir(parents=True, exist_ok=False)
        # Independent immutable copies are an existing capsule contract. Never
        # weaken or repair a rejected shared CAS object during task submission.
        before = native_identity(source_repo, "snapshot") if development else None
        manifest = capture_source(source_repo, destination, mode=mode, ref=commit, content_store=None)
        after = native_identity(source_repo, mode, manifest["resolved_commit"])
        if before is not None and before != after:
            raise ValueError("Selected checkout changed during backend snapshot capture")
        native = bind_identity(after, manifest)
        commit = manifest["resolved_commit"]
    submitted = {"worktree_id": layout["worktree_id"], "source_digest": manifest["source_digest"],
                 "profile": "fem-gpu-release", "operation": "build", "request_key": capture_id,
                 "payload": {"source_mode": mode, "origin_repo": str(source_repo),
                             "capture_id": capture_id, "native_source_identity": native,
                             "capsule_relative": destination.relative_to(Path(layout["storage_root"])).as_posix()}}
    receipt = {"schema": "fullmag.docker-all-submission.v1", "state": "submitting",
               "source_storage": "independent-copy", "capture_id": capture_id,
               "request_key": submitted["request_key"], "capsule_relative": submitted["payload"]["capsule_relative"],
               "commit": commit, "source_mode": mode, "source_root": str(source_repo),
               "native_source_identity": native, "source_digest": manifest["source_digest"], "submission": submitted}
    receipt_path = destination.parent / "submission.json"
    storage.atomic_json(receipt_path, receipt)
    try:
        result = request(layout, owner=owner, method="POST", path="/jobs", payload=submitted)
        receipt.update(state="submitted", result=result,
                       queue_state_at_submission=result.get("state", "unconfirmed"),
                       build_claimed_at_submission=result.get("state") == "running",
                       build_qualification="NOT VERIFIED",
                       next_step="Use runner-status/runner-wait; assemble only a terminal succeeded build",
                       queue_policy="Running Fullmag runtime containers postpone the heavy build; submission never stops or restarts them")
    except Exception as error:
        receipt.update(state="submission_unconfirmed", error=str(error))
        raise
    finally:
        storage.atomic_json(receipt_path, receipt)
        print(json.dumps(receipt, indent=2))


def stage_image_context(capsule, package, stage, *, development):
    """Stage operational helpers; application inputs are mounted in development."""
    if not development:
        shutil.copytree(capsule / "tree", stage / "source", symlinks=False)
        shutil.copytree(package, stage / "package", symlinks=False)
    for name in ("entrypoint.py", "windows_folder_probe.py", "runtime_service.py", "frontend_dev.py", "healthcheck.py"):
        shutil.copyfile(capsule / "tree/docker/all-in-one" / name, stage / name)
    for name in ("docker_startup_script.py", "fullmag_storage.py"):
        source = capsule / "tree/scripts" / name
        if not source.is_file():
            raise ValueError(f"Missing pinned Docker startup helper dependency: scripts/{name}")
        shutil.copyfile(source, stage / name)
    shutil.copyfile(capsule / "tree/docker/all-in-one" / ("Dockerfile.dev" if development else "Dockerfile"),
                    stage / "Dockerfile")
    return {path.name: digest(path) for path in (package / "bin").iterdir() if path.is_file()}


def build_image(repo, job_id, commit, *, source_digest=None, native_snapshot_sha256=None, development=False, source_root=None):
    if source_root is not None or source_digest is not None:
        from docker_development_inputs import select_checkout
        repo = select_checkout(repo, source_root)
    layout = storage.resolve_layout(repo, PROFILE)
    # Resolve before the first write, then retain the package-use lease during copy.
    with runtime_package_use(layout):
        root, context, built, capsule, package = prepare_gpu_release(layout, job_id, commit, source_digest=source_digest,
                                                                         native_snapshot_sha256=native_snapshot_sha256)
        storage.initialize(layout)
        output = storage.validate_path(Path(layout["build_root"]) / "images" / uuid.uuid4().hex,
                                       Path(layout["build_storage_root"]))
        output.mkdir(parents=True, exist_ok=False, mode=0o700)
        receipt = {"schema": "fullmag.docker-all-image.v1", "state": "assembling",
                   "qualification": "NOT VERIFIED", "job_id": job_id, "commit": commit,
                   "source_mode": "snapshot" if source_digest is not None else "commit",
                   "source_digest": context["source_digest"], "base_image": context["image_digest"],
                   "native_source_identity": built["native_source_identity"],
                   "build_receipt_sha256": digest(root / "artifacts/build-receipt.json"),
                   "output": str(output), "unit_tests_compiled": False,
                   "runtime_mode": "development_source_bind" if development else "packaged_release",
                   "package_root": str(package)}
        consumer = storage.validate_path(Path(layout["runtime_root"]) / "docker-all-images" / output.name,
                                         Path(layout["build_storage_root"]))
        consumer.mkdir(parents=True, exist_ok=False)
        register_runtime_reference_root(layout, consumer)
        receipt_path = consumer / "receipt.json"
        receipt["receipt"] = str(receipt_path)
        storage.atomic_json(receipt_path, receipt)
        try:
            stage = output / "context"
            stage.mkdir()
            # The trusted capsule excludes .env, Git internals and host caches.
            receipt["binary_hashes"] = stage_image_context(capsule, package, stage, development=development)
            receipt["startup_helper_hashes"] = {
                name: digest(stage / name)
                for name in ("docker_startup_script.py", "fullmag_storage.py")
            }
            (stage / "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n")
            # Docker FROM expects a repository reference, so create an explicit
            # local alias and attest its ID immediately before the offline build.
            alias = "fullmag/docker-all-base:" + output.name
            docker("tag", context["image_digest"], alias)
            if json.loads(docker("image", "inspect", alias))[0]["Id"] != context["image_digest"]:
                raise ValueError("Local base image alias changed")
            builder = "desktop-linux" if os.name == "nt" else docker("context", "show")
            description = docker("buildx", "inspect", builder)
            if not re.search(r"^Driver:\s+docker\s*$", description, re.MULTILINE):
                raise ValueError("Offline assembly requires the existing engine-integrated Docker builder")
            iid = output / "image-id.txt"
            logs = docker("build", "--builder", builder, "--network", "none", "--pull=false", "--build-arg",
                          "RUNTIME_BASE=" + alias, "--build-arg",
                          "FULLMAG_TOOLCHAIN_IMAGE_ID=" + context["image_digest"], "--iidfile", str(iid), str(stage), combined=True, timeout=1800)
            (output / "assembly.log").write_text(logs)
            immutable = iid.read_text().strip()
            validate_workspace_environment(image_id(immutable)["Config"])
            verify_source(capsule, context["source_digest"])
            receipt.update(state="succeeded", image_id=immutable, exit_code=0)
        except Exception as error:
            receipt.update(state="failed", error=str(error))
            if isinstance(error, DockerOutcomeUnknown):
                receipt.update(state="assembly_outcome_unknown_resources_retained",
                               timed_out_operation=error.operation,
                               client_timeout_seconds=error.timeout_seconds)
            raise
        finally:
            storage.atomic_json(receipt_path, receipt)
            print(json.dumps(receipt, indent=2))


def _write_startup_overlay(path, authorization, *, include_source,
                           provenance_sha256=None, helper_sha256=None):
    """Create a JSON Compose overlay for one already-admitted script.

    The base Compose files intentionally have no optional host path.  This
    overlay is created only after the bounded source admission succeeds, so an
    ordinary runtime has exactly the old mounts and environment.
    """
    source_root = Path(authorization["source_root"])
    provenance = Path(path).with_name("startup-provenance.json")
    volumes = [
        {
            "type": "bind",
            "source": str(provenance),
            "target": "/run/fullmag/startup-provenance.json",
            "read_only": True,
            "bind": {"create_host_path": False},
        }
    ]
    if include_source:
        volumes.insert(0, {
            "type": "bind",
            "source": str(source_root),
            "target": "/opt/fullmag/source",
            "read_only": True,
            "bind": {"create_host_path": False},
        })
    environment = {
        "FULLMAG_STARTUP_ENABLED": "1",
        "FULLMAG_STARTUP_SCRIPT": authorization["container_script_path"],
        "FULLMAG_STARTUP_PROVENANCE": "/run/fullmag/startup-provenance.json",
        "FULLMAG_STARTUP_API": "http://127.0.0.1:8081",
    }
    if provenance_sha256 is not None:
        if not re.fullmatch(r"[0-9a-f]{64}", provenance_sha256):
            raise ValueError("Startup provenance digest is invalid")
        environment["FULLMAG_STARTUP_PROVENANCE_SHA256"] = provenance_sha256
    if helper_sha256 is not None:
        if not re.fullmatch(r"[0-9a-f]{64}", helper_sha256):
            raise ValueError("Startup helper digest is invalid")
        environment["FULLMAG_STARTUP_HELPER_SHA256"] = helper_sha256
    overlay = {
        "services": {
            "backend": {
                "environment": environment,
                "volumes": volumes,
            }
        }
    }
    storage.atomic_json(path, overlay)


def _write_recovery_overlay(path, authorization_path):
    """Expose one host-pinned recovery authorization read-only to backend only."""

    authorization_path = Path(authorization_path)
    if (authorization_path.is_symlink() or not authorization_path.is_file()
            or not authorization_path.is_absolute()):
        raise ValueError("Runtime recovery authorization must be an absolute regular file")
    storage.atomic_json(path, {
        "services": {
            "backend": {
                "environment": {
                    "FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION":
                    "/run/fullmag/runtime-recovery-authorization.json",
                },
                "volumes": [{
                    "type": "bind",
                    "source": str(authorization_path.resolve()),
                    "target": "/run/fullmag/runtime-recovery-authorization.json",
                    "read_only": True,
                    "bind": {"create_host_path": False},
                }],
            }
        }
    })


_STARTUP_HELPERS = ("docker_startup_script.py", "fullmag_storage.py")
_STARTUP_HELPER_MODULES = {
    "docker_startup_script.py": "docker_startup_script",
    "fullmag_storage.py": "fullmag_storage",
}
_MAX_STARTUP_HELPER_BYTES = 4 * 1024 * 1024


def _read_startup_helper_bytes(path):
    """Read one helper through a bounded native no-follow file operation."""

    path = Path(path)
    if os.name == "nt":
        from windows_folder_host import read_owned_regular

        return read_owned_regular(path, maximum=_MAX_STARTUP_HELPER_BYTES)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ValueError(f"Cannot open startup helper: {path}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > _MAX_STARTUP_HELPER_BYTES:
            raise ValueError("Startup helper is not a bounded regular file")
        chunks = bytearray()
        while len(chunks) <= _MAX_STARTUP_HELPER_BYTES:
            chunk = os.read(
                descriptor,
                min(64 * 1024, _MAX_STARTUP_HELPER_BYTES + 1 - len(chunks)),
            )
            if not chunk:
                break
            chunks.extend(chunk)
        if len(chunks) > _MAX_STARTUP_HELPER_BYTES:
            raise ValueError("Startup helper exceeds its size bound")
        return bytes(chunks)
    except OSError as error:
        raise ValueError(f"Cannot read startup helper: {path}") from error
    finally:
        os.close(descriptor)


def _verified_startup_helper(path, expected_hash):
    data = _read_startup_helper_bytes(path)
    observed = hashlib.sha256(data).hexdigest()
    return data, observed == expected_hash, observed


def _exec_verified_startup_helpers(helpers):
    """Execute an already-read helper pair under temporary canonical names."""

    module_names = tuple(_STARTUP_HELPER_MODULES.values())
    missing = object()
    saved = {name: sys.modules.get(name, missing) for name in module_names}
    try:
        loaded = {}
        for filename in ("fullmag_storage.py", "docker_startup_script.py"):
            module_name = _STARTUP_HELPER_MODULES[filename]
            path, data = helpers[filename]
            module = types.ModuleType(module_name)
            module.__file__ = str(path)
            module.__package__ = ""
            module.__loader__ = None
            module.__spec__ = None
            sys.modules[module_name] = module
            code = compile(data, str(path), "exec", dont_inherit=True)
            exec(code, module.__dict__)
            loaded[module_name] = module
        return loaded["docker_startup_script"]
    finally:
        for name, previous in saved.items():
            if previous is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


def _assembly_helper_context(assembly, layout):
    """Return the immutable helper context recorded by the assembly receipt."""

    expected = assembly.get("startup_helper_hashes")
    if not isinstance(expected, dict) or set(expected) != set(_STARTUP_HELPERS):
        raise ValueError("Assembly receipt has no complete pinned startup helper inventory")
    output = assembly.get("output")
    if not isinstance(output, str) or not output:
        raise ValueError("Assembly receipt has no frozen helper context")
    build_root = Path(layout["build_storage_root"])
    context = storage.validate_path(Path(output) / "context", build_root,
                                    "assembly helper context")
    verified = {}
    for name in _STARTUP_HELPERS:
        helper = storage.validate_path(context / name, context, "assembly helper")
        data, matches, _observed = _verified_startup_helper(helper, expected[name])
        if not matches:
            raise ValueError("Frozen assembly helper differs from its receipt inventory: " + name)
        verified[name] = (helper, data)
    return verified


def _startup_helper_for_start(assembly, layout, selected_source):
    """Use the selected checkout only when its helper bytes match the image."""

    expected = assembly["startup_helper_hashes"]
    observed = {}
    verified = {}
    matches = True
    for name in _STARTUP_HELPERS:
        path = Path(selected_source) / "scripts" / name
        if not os.path.lexists(path):
            observed[name] = None
        else:
            # A helper that exists through a symlink/junction is not treated as
            # a harmless inventory mismatch: the selected checkout itself must
            # remain a real, owned tree before its bytes are considered.
            path = storage.validate_path(path, Path(selected_source), "startup helper")
            if not path.is_file():
                observed[name] = None
            else:
                data, matches_hash, observed[name] = _verified_startup_helper(
                    path, expected[name]
                )
                verified[name] = (path, data)
                matches = matches and matches_hash
        if name not in verified:
            matches = False
    if matches:
        startup_helper = _exec_verified_startup_helpers(verified)
        return startup_helper, {"source": "selected_checkout", "hashes": observed}
    frozen = _assembly_helper_context(assembly, layout)
    return _exec_verified_startup_helpers(frozen), {
        "source": "assembly_context",
        "hashes": observed,
        "expected_hashes": dict(expected),
    }


def _require_static_source_identity(assembly, selected_source):
    """Require a static/startup source bind to name the assembled Git tree."""

    expected = assembly.get("native_source_identity")
    mode = assembly.get("source_mode")
    commit = assembly.get("commit")
    if (mode not in {"commit", "snapshot"}
            or not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit)
            or not isinstance(expected, dict)):
        raise ValueError("Static startup source bind has no complete assembly source identity")
    from local_runner.build_source import native_identity
    # The bind exposes the selected checkout's working-tree bytes.  A
    # commit-mode identity alone would only prove that the requested Git
    # object exists and could miss a dirty file that the container would read.
    observed = native_identity(Path(selected_source), "snapshot")
    if observed != expected:
        raise ValueError("Static startup source bind differs from the assembled native source identity")
    return observed


def _validate_assembly_source_provenance(assembly, *, frontend):
    """Validate the source contract before any runtime state is mutated.

    A live development image is backed by the selected checkout and its
    immutable shadow manifest; it deliberately has no source archive.  The
    archive/commit/snapshot forms remain the strict legacy contract used by
    packaged and previously assembled images.  This check is intentionally
    receipt-only: it does not inspect or recapture a mutable checkout.
    """

    if not isinstance(assembly, dict):
        raise ValueError("Assembly receipt source provenance is not an object")
    mode = assembly.get("source_mode")
    if mode not in {"archive", "commit", "snapshot", "live-shadow-v1"}:
        raise ValueError("Assembly receipt has an unsupported source mode")
    commit = assembly.get("commit")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Assembly receipt has no canonical source commit")
    source_digest = assembly.get("source_digest")
    if not isinstance(source_digest, str) or not _CONFIG_SHA256_RE.fullmatch(source_digest):
        raise ValueError("Assembly receipt has no canonical source digest")
    native = assembly.get("native_source_identity")
    if not isinstance(native, dict):
        raise ValueError("Assembly receipt has no native source identity")
    if native.get("head_commit_full") != commit:
        raise ValueError("Assembly receipt native source identity differs from its commit")
    native_snapshot = native.get("source_snapshot_sha256")
    if not isinstance(native_snapshot, str) or not _CONFIG_SHA256_RE.fullmatch(native_snapshot):
        raise ValueError("Assembly receipt native source identity has no snapshot digest")
    if "source_snapshot_sha256" in assembly:
        if assembly["source_snapshot_sha256"] != native_snapshot:
            raise ValueError("Assembly receipt source snapshot differs from native source identity")
    runtime_mode = assembly.get("runtime_mode")
    if not isinstance(runtime_mode, str) or runtime_mode not in {
        "development_source_bind", "packaged_release",
    }:
        raise ValueError("Assembly receipt has an unsupported runtime mode")

    if mode == "live-shadow-v1":
        if frontend != "dev" or runtime_mode != "development_source_bind":
            raise ValueError("Live source provenance is allowed only for development runtime")
        live_manifest = assembly.get("live_manifest_sha256")
        if not isinstance(live_manifest, str) or not _CONFIG_SHA256_RE.fullmatch(live_manifest):
            raise ValueError("Live source assembly has no canonical live manifest digest")
        source_manifest = assembly.get("source_manifest")
        git_common = assembly.get("source_git_common_dir")
        if not isinstance(git_common, str) or not git_common:
            raise ValueError("Live source assembly has incomplete Git provenance")
        if source_manifest is not None and (
                not isinstance(source_manifest, str) or not source_manifest):
            raise ValueError("Live source assembly has an invalid optional manifest provenance")
        if "source_archive" in assembly or "source_tar_sha256" in assembly:
            raise ValueError("Live source assembly must not claim a source archive")
        return {
            "source_mode": mode,
            "source_digest": source_digest,
            "source_snapshot_sha256": native_snapshot,
            "live_manifest_sha256": live_manifest,
        }

    # A legacy/archive assembly may carry an immutable archive descriptor.  If
    # present, validate its complete shape; do not synthesize one for managed
    # receipts that predate the descriptor.
    archive = assembly.get("source_archive")
    if archive is not None:
        if not isinstance(archive, dict):
            raise ValueError("Assembly source archive provenance is not an object")
        required = {"path", "manifest_path", "sha256", "bytes"}
        if not required.issubset(archive):
            raise ValueError("Assembly source archive provenance is incomplete")
        if (not isinstance(archive["path"], str) or not archive["path"]
                or not isinstance(archive["manifest_path"], str) or not archive["manifest_path"]
                or not isinstance(archive["sha256"], str)
                or not _CONFIG_SHA256_RE.fullmatch(archive["sha256"])
                or isinstance(archive["bytes"], bool)
                or not isinstance(archive["bytes"], int)
                or archive["bytes"] <= 0):
            raise ValueError("Assembly source archive provenance is invalid")
    if "live_manifest_sha256" in assembly or "source_git_common_dir" in assembly:
        raise ValueError("Static source assembly contains live-only provenance")
    return {
        "source_mode": mode,
        "source_digest": source_digest,
        "source_snapshot_sha256": native_snapshot,
    }


def _read_reuse_json(path, label, maximum=16 * 1024 * 1024):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{label} is not a regular file: {path}")
    if path.stat().st_size <= 0 or path.stat().st_size > maximum:
        raise ValueError(f"{label} is outside its bounded size: {path}")
    try:
        if os.name == "nt":
            from windows_folder_host import read_owned_regular
            raw = read_owned_regular(path, maximum=maximum)
        else:
            raw = path.read_bytes()
        value = json.loads(raw)
    except (OSError, UnicodeError, ValueError) as error:
        raise ValueError(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain an object")
    return value


def _container_inspect(container_id):
    if not isinstance(container_id, str) or _CONTAINER_ID_RE.fullmatch(container_id) is None:
        raise ValueError("Reused Docker receipt has an invalid container ID")
    try:
        value = json.loads(docker("inspect", container_id))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("Reused Docker container could not be inspected") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise ValueError("Reused Docker container inspect returned an unexpected document")
    document = value[0]
    actual_id = document.get("Id")
    if (not isinstance(actual_id, str) or _CONTAINER_ID_RE.fullmatch(actual_id) is None
            or not actual_id.startswith(container_id)):
        raise ValueError("Reused Docker container identity changed")
    return document


def _compose_service_container_id(compose_args, service):
    """Return exactly one running container ID for an owned Compose service."""

    if not isinstance(service, str) or not re.fullmatch(r"[a-z][a-z0-9_-]*", service):
        raise ValueError("Compose service name is invalid")
    raw = docker(*compose_args, "ps", "--quiet", service)
    ids = [item.strip() for item in raw.splitlines() if item.strip()]
    if len(ids) != 1 or _CONTAINER_ID_RE.fullmatch(ids[0]) is None:
        raise ValueError(
            f"Compose service {service} did not return exactly one valid running container ID"
        )
    return ids[0]


def _mount_source(source):
    if not isinstance(source, str) or not source:
        return None
    try:
        return host_path(source)
    except (OSError, ValueError, TypeError):
        return None


def _paths_overlap(left, right):
    return left == right or left in right.parents or right in left.parents


def _validate_reuse_container(document, *, container_id, project, service, image, state):
    labels = document.get("Config", {}).get("Labels")
    if (not isinstance(labels, dict)
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != service):
        raise ValueError(f"Reused {service} container Compose ownership changed")
    if document.get("Image") != image:
        raise ValueError(f"Reused {service} container image changed")
    state_info = document.get("State")
    if (not isinstance(state_info, dict) or state_info.get("Running") is not False
            or state_info.get("Status") not in {"created", "exited"}):
        raise ValueError(f"Reused {service} container is not stopped")
    mounts = document.get("Mounts")
    if not isinstance(mounts, list):
        raise ValueError(f"Reused {service} container has no mount inventory")
    target = "/state" if service == "backend" else "/state/development"
    expected_source = state if service == "backend" else state / "development"
    matches = []
    for mount in mounts:
        if not isinstance(mount, dict) or mount.get("Type") != "bind":
            continue
        if mount.get("Destination") != target:
            continue
        source = _mount_source(mount.get("Source"))
        if source is not None and source == expected_source.resolve():
            matches.append(mount)
    if len(matches) != 1 or matches[0].get("RW") is not True:
        raise ValueError(f"Reused {service} container state mount changed")


def _validate_reuse_containers(reuse, *, project, frontend, retained_container_ids=None):
    """Prove stopped owned services and quiescent state mounts before mutation."""
    receipt = reuse["receipt"]
    image = receipt.get("image_id")
    if not isinstance(image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("Reused Docker receipt has no immutable image ID")
    backend_id = receipt.get("container_id")
    frontend_id = receipt.get("frontend_container_id")
    documents = {}
    if retained_container_ids is not None:
        if frontend != "dev":
            raise ValueError("Failed retained recovery requires the two-service development run")
        for retained_id in retained_container_ids:
            document = _container_inspect(retained_id)
            labels = document.get("Config", {}).get("Labels")
            service = labels.get("com.docker.compose.service") if isinstance(labels, dict) else None
            if service not in {"backend", "frontend"} or service in documents:
                raise ValueError("Failed retained container service identity is ambiguous")
            if labels.get("com.docker.compose.project") != project:
                raise ValueError("Failed retained container Compose ownership changed")
            documents[service] = (retained_id, document)
        if set(documents) != {"backend", "frontend"}:
            raise ValueError("Failed retained run does not contain exactly backend and frontend")
        backend_id, backend = documents["backend"]
        frontend_id, frontend_document = documents["frontend"]
    else:
        if backend_id is None:
            raise ValueError("Reused Docker receipt has no backend container ID")
        backend = _container_inspect(backend_id)
    _validate_reuse_container(
        backend,
        container_id=backend_id,
        project=project,
        service="backend",
        image=image,
        state=reuse["state"],
    )
    if frontend == "dev":
        if frontend_id is None:
            raise ValueError("Reused Docker receipt has no frontend container ID")
        if retained_container_ids is None:
            frontend_document = _container_inspect(frontend_id)
        _validate_reuse_container(
            frontend_document,
            container_id=frontend_id,
            project=project,
            service="frontend",
            image=image,
            state=reuse["state"],
        )
    running_raw = docker("ps", "--quiet")
    running_ids = [value for value in running_raw.splitlines() if value]
    state = reuse["state"].resolve()
    for running_id in running_ids:
        running = _container_inspect(running_id)
        labels = running.get("Config", {}).get("Labels")
        if isinstance(labels, dict) and labels.get("com.docker.compose.project") == project:
            raise ValueError("A running container still belongs to the reused Compose project")
        for mount in running.get("Mounts", []):
            if not isinstance(mount, dict) or mount.get("Type") != "bind":
                continue
            source = _mount_source(mount.get("Source"))
            if source is not None and _paths_overlap(source, state):
                raise ValueError("A running container still mounts the reused session state")


def _validate_failed_retained_receipt(receipt, *, allow):
    """Admit the failed retained state only for an explicit recovery fence."""

    if receipt.get("state") != "failed_resources_retained":
        return
    if not allow:
        raise ValueError("Failed retained run requires --recover-idle-failure authorization")
    retained = receipt.get("retained_container_ids")
    if (not isinstance(retained, list) or len(retained) != 2
            or len(set(retained)) != 2
            or any(not isinstance(value, str) or not _CONTAINER_ID_RE.fullmatch(value)
                   for value in retained)):
        raise ValueError("Failed retained run has no exact two-container retention proof")
    declared = {receipt.get("container_id"), receipt.get("frontend_container_id")}
    if None in declared and declared != {None}:
        raise ValueError("Failed retained run has only a partial service container declaration")
    if None not in declared and declared != set(retained):
        raise ValueError("Failed retained run container IDs disagree with retention proof")


def _load_reuse_run(layout, run_receipt, *, project_name, frontend,
                    previous_config_sha256=None,
                    allow_failed_resources_retained=False):
    """Validate one explicitly named run before reuse or fenced recovery."""
    if run_receipt is None:
        return None
    runs_root = storage.validate_path(
        Path(layout["runs_root"]) / "docker-all",
        Path(layout["storage_root"]),
        "Docker runtime runs root",
    )
    receipt_path = storage.validate_path(Path(run_receipt), runs_root,
                                         "Docker runtime run receipt")
    root = receipt_path.parent
    if (receipt_path.name != "receipt.json" or root.parent != runs_root
            or _RUN_ID_RE.fullmatch(root.name) is None):
        raise ValueError("--run-receipt must name a direct docker-all run receipt")
    receipt_sha256 = digest(receipt_path)
    receipt = _read_reuse_json(receipt_path, "Docker runtime run receipt")
    if receipt.get("schema") != "fullmag.docker-all-run.v1":
        raise ValueError("Docker runtime run receipt has an unsupported schema")
    receipt_state = receipt.get("state")
    allowed_states = {"running", "stopped"}
    if allow_failed_resources_retained:
        allowed_states.add("failed_resources_retained")
    if receipt_state not in allowed_states:
        if receipt_state == "failed_resources_retained":
            _validate_failed_retained_receipt(receipt, allow=False)
        raise ValueError("--run-receipt must reference a running or gracefully stopped run")
    _validate_failed_retained_receipt(
        receipt, allow=allow_failed_resources_retained
    )
    project = receipt.get("compose_project")
    if (not isinstance(project, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project)
            or project_name is not None and project != project_name):
        raise ValueError("Docker runtime run project identity does not match the requested project")
    if receipt.get("frontend_mode") != frontend:
        raise ValueError("Reused run frontend mode differs from the requested mode")
    expected_paths = {
        "state_root": root / "state",
        "compose_file": root / "compose.json",
    }
    for field, expected in expected_paths.items():
        value = receipt.get(field)
        if not isinstance(value, str) or Path(value).resolve() != expected.resolve():
            raise ValueError(f"Docker runtime receipt has an unexpected {field}")
    certificate_value = receipt.get("host_certificate")
    if (not isinstance(certificate_value, str)
            or Path(certificate_value).resolve() != (root / "windows-folder-host.json").resolve()):
        raise ValueError("Docker runtime receipt has an unexpected host certificate path")
    state = storage.validate_path(root / "state", root, "reused runtime state")
    if not state.is_dir() or state.is_symlink():
        raise ValueError("Reused runtime state is not a real directory")
    session_store = state / "runs" / "docker-all" / "session-store"
    if not session_store.is_dir() or session_store.is_symlink():
        raise ValueError("Reused runtime session store is missing or not a real directory")
    host_certificate = root / "windows-folder-host.json"
    owner_marker = state / ".fullmag-windows-folder-owner.json"
    for path, label in ((host_certificate, "reused Windows host certificate"),
                        (owner_marker, "reused Windows storage owner marker")):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"{label} is missing or not a regular file")
    old_assembly = receipt.get("assembly_receipt")
    if not isinstance(old_assembly, str):
        raise ValueError("Reused run has no prior assembly receipt")
    old_assembly = storage.validate_path(old_assembly, Path(layout["build_storage_root"]),
                                         "prior assembly receipt")
    if digest(old_assembly) != receipt.get("assembly_receipt_sha256"):
        raise ValueError("Prior assembly receipt digest changed")
    config = state / RUNTIME_CONFIG_RELATIVE
    if previous_config_sha256 is not None:
        if _CONFIG_SHA256_RE.fullmatch(str(previous_config_sha256)) is None:
            raise ValueError("--previous-config-sha256 must be a lowercase SHA-256 digest")
        if config.is_symlink() or not config.is_file() or digest(config) != previous_config_sha256:
            raise ValueError("Previous runtime configuration digest does not match the reused state")
    source_root = receipt.get("frontend_source_root")
    host_inputs_value = receipt.get("frontend_host_inputs")
    guest_inputs_value = receipt.get("frontend_inputs")
    frontend_inputs = None
    guest_inputs = None
    if frontend == "dev":
        if not isinstance(source_root, str) or not Path(source_root).is_dir() or Path(source_root).is_symlink():
            raise ValueError("Reused development run has no valid live source checkout")
        if not isinstance(host_inputs_value, str) or not isinstance(guest_inputs_value, str):
            raise ValueError("Reused development run has no complete frontend input manifests")
        frontend_inputs = storage.validate_path(host_inputs_value, root,
                                                 "prior frontend input manifest")
        guest_inputs = storage.validate_path(guest_inputs_value, root,
                                             "prior guest frontend input manifest")
        if (frontend_inputs.is_symlink() or not frontend_inputs.is_file()
                or guest_inputs.is_symlink() or not guest_inputs.is_file()):
            raise ValueError("Prior frontend input manifest is not a regular file")
        for path, field in ((frontend_inputs, "frontend_host_inputs_sha256"),
                            (guest_inputs, "frontend_inputs_sha256")):
            expected = receipt.get(field)
            if not isinstance(expected, str) or not _CONFIG_SHA256_RE.fullmatch(expected):
                raise ValueError(f"Reused development run has no valid {field}")
            if digest(path) != expected:
                raise ValueError(f"Reused development run {field} changed")
    _validate_reuse_containers(
        {"receipt": receipt, "state": state},
        project=project,
        frontend=frontend,
        retained_container_ids=(
            receipt.get("retained_container_ids")
            if receipt_state == "failed_resources_retained" else None
        ),
    )
    if digest(receipt_path) != receipt_sha256:
        raise ValueError("Reused Docker run receipt changed during admission")
    return {
        "receipt_path": receipt_path,
        "receipt_sha256": receipt_sha256,
        "receipt": receipt,
        "root": root,
        "state": state,
        "project": project,
        "host_certificate": host_certificate,
        "owner_marker": owner_marker,
        "source_root": Path(source_root).resolve() if isinstance(source_root, str) else None,
        "frontend_inputs": frontend_inputs,
        "guest_inputs": guest_inputs,
        "previous_config_sha256": previous_config_sha256,
        "reuse_token": uuid.uuid4().hex,
    }


def _select_reuse_compose_identity(source_identity, expected_project, reuse):
    """Select the project identity for a fresh start or explicit reuse.

    The checkout-derived project name is mandatory for fresh starts.  A
    legacy ``fullmag`` name is accepted only after ``_load_reuse_run`` has
    admitted an explicitly named run and only for that run's recreation.  The
    adapter does not rename containers, import metadata, or mutate the reuse
    receipt; it only supplies the recorded labels to the Compose attestation.
    """
    if reuse is None:
        return expected_project, source_identity, None

    project = reuse.get("project")
    if project == expected_project:
        return project, source_identity, None
    if project != LEGACY_COMPOSE_PROJECT:
        raise ValueError("Reused Compose project does not match the selected source checkout")

    receipt = reuse.get("receipt")
    if not isinstance(receipt, dict):
        raise ValueError("Legacy reused run has no validated receipt")
    recorded = {field: receipt.get(field) for field in _SOURCE_IDENTITY_FIELDS}
    present = [field in receipt for field in _SOURCE_IDENTITY_FIELDS]
    if any(present) and not all(present):
        raise ValueError("Legacy reused run has a partial source identity")

    adapted = dict(source_identity)
    adapted["project_name"] = LEGACY_COMPOSE_PROJECT
    adapted["network_name"] = f"{LEGACY_COMPOSE_PROJECT}_fullmag"
    if all(present):
        for field in _SOURCE_IDENTITY_FIELDS:
            value = recorded[field]
            if not isinstance(value, str) or _SOURCE_LABEL_VALUE_RE.fullmatch(value) is None:
                raise ValueError("Legacy reused run has an invalid source identity label")
        if recorded["source_project_id"] != source_identity["project_id"]:
            raise ValueError("Legacy reused run belongs to another source project")
        if recorded["source_worktree_id"] != source_identity["worktree_id"]:
            raise ValueError("Legacy reused run belongs to another registered checkout")
        # Preserve the label emitted by the retained run. Older receipts may
        # use ``master`` while the canonical identity now says
        # ``main-checkout``; this field is provenance, not branch selection.
        adapted["checkout_kind"] = recorded["source_checkout_kind"]
    return project, adapted, "legacy-compose-project"


def _select_migration_compose_identity(source_identity, expected_project, reuse):
    """Promote one validated legacy run to the selected checkout's project.

    This is an explicit metadata/Compose identity change only.  The caller
    keeps ``reuse["root"]`` and ``reuse["state"]`` and must perform the target
    project absence fence before preserving evidence or publishing a config.
    """
    if (reuse is None or reuse.get("project") != LEGACY_COMPOSE_PROJECT
            or expected_project == LEGACY_COMPOSE_PROJECT):
        raise ValueError("Compose project migration requires a validated legacy fullmag run")
    _, legacy_identity, _ = _select_reuse_compose_identity(
        source_identity, expected_project, reuse
    )
    migrated = dict(legacy_identity)
    migrated["project_name"] = expected_project
    migrated["network_name"] = source_identity["network_name"]
    return expected_project, migrated, "legacy-compose-project-migrated"


def _assert_compose_project_absent(project, source_identity):
    """Reuse the all-state/container and network admission fence for a target."""
    from docker_dev import _assert_no_running_fullmag

    _assert_no_running_fullmag(project, source_identity)


def _preserve_reuse_evidence(reuse):
    """Copy only owned run metadata before any same-run receipt is replaced."""
    root = reuse["root"]
    root_resolved = root.resolve()
    expected_receipt_sha256 = reuse.get("receipt_sha256")
    if (expected_receipt_sha256 is not None
            and digest(reuse["receipt_path"]) != expected_receipt_sha256):
        raise ValueError("Reused run receipt changed before its evidence was preserved")
    history = root / "receipt-history" / reuse["reuse_token"]
    history.mkdir(parents=True, exist_ok=False)
    relative_paths = [
        Path("receipt.json"), Path("compose.json"), Path("compose.source.yaml"),
        Path("windows-folder-host.json"),
        Path("frontend-cache-receipt.json"), Path("development-inputs.json"),
        Path("development-inputs-host.json"), Path("startup-provenance.json"),
        Path("compose.startup.json"), Path("state/.fullmag-windows-folder-owner.json"),
        Path("state/.fullmag-windows-folder-grant.json"),
        Path("state/.windows-folder-probe/probe-first.json"),
        Path("state/.windows-folder-probe/probe-restart.json"),
        Path("state/.windows-folder-probe/restart-sentinel.bin"),
        RUNTIME_CONFIG_HISTORY_RELATIVE,
    ]
    # Later recreates keep their receipts in a tokenized metadata directory.
    # Preserve every path-valued evidence field from the old receipt as well,
    # but only when it resolves inside this owned run root.
    def collect_paths(value):
        if isinstance(value, dict):
            for item in value.values():
                yield from collect_paths(item)
        elif isinstance(value, list):
            for item in value:
                yield from collect_paths(item)
        elif isinstance(value, str):
            candidate = Path(value)
            if not candidate.is_absolute():
                return
            if (not candidate.exists() and not candidate.is_symlink()) or candidate.is_dir():
                return
            try:
                relative = candidate.resolve().relative_to(root_resolved)
            except (OSError, ValueError):
                return
            if relative != Path("receipt.json"):
                yield relative

    for relative in collect_paths(reuse["receipt"]):
        if relative not in relative_paths:
            relative_paths.append(relative)
    archived = []
    for relative in relative_paths:
        source = root / relative
        if not source.exists() and not source.is_symlink():
            continue
        if source.is_symlink() or not source.is_file():
            raise ValueError("Reused run evidence is not a regular file: " + str(source))
        destination = history / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        archived.append({"relative": relative.as_posix(),
                         "sha256": digest(destination),
                         "size_bytes": destination.stat().st_size})
    if not archived or not any(item["relative"] == "receipt.json" for item in archived):
        raise ValueError("Reused run receipt could not be preserved")
    source_receipt_sha256 = expected_receipt_sha256 or digest(reuse["receipt_path"])
    if digest(history / "receipt.json") != source_receipt_sha256:
        raise ValueError("Reused run receipt changed while its evidence was preserved")
    storage.atomic_json(history / "manifest.json", {
        "schema": "fullmag.docker-all-reuse-history.v1",
        "source_receipt": str(reuse["receipt_path"]),
        "source_receipt_sha256": source_receipt_sha256,
        "files": archived,
    })
    reuse["history_root"] = history
    reuse["metadata_root"] = root / ".recreate" / reuse["reuse_token"]
    reuse["metadata_root"].mkdir(parents=True, exist_ok=False)
    return reuse


def _record_recreate_preflight_failure(reuse, *, phase, error):
    """Record a failed reuse preflight without replacing the active receipt.

    A reuse attempt is allowed to create evidence under ``receipt-history``
    before any runtime state or Compose service is changed.  The direct run
    receipt remains the last verified pointer, so a later explicit retry can
    still pass the normal CAS and stopped-container admission checks.
    """
    _preserve_reuse_evidence(reuse)
    history = reuse["history_root"]
    source_receipt = history / "receipt.json"
    source_receipt_sha256 = digest(source_receipt)
    attempt = {
        "schema": "fullmag.docker-all-recreate-attempt.v1",
        "state": "failed_preflight",
        "failure_phase": phase,
        "error": str(error),
        "service_mutation": "not_started",
        "runtime_state_mutation": "not_started",
        "active_receipt": str(reuse["receipt_path"]),
        "active_receipt_sha256": source_receipt_sha256,
        "reused_from": str(reuse["receipt_path"]),
        "reused_from_sha256": source_receipt_sha256,
        "preserved_receipt": str(source_receipt),
        "preserved_receipt_sha256": source_receipt_sha256,
        "history_root": str(history),
        "reuse_token": reuse["reuse_token"],
        "compose_project": reuse["project"],
        "state_root": str(reuse["state"]),
        "host_certificate": str(reuse["host_certificate"]),
        "owner_marker": str(reuse["owner_marker"]),
        "backend_container_id": reuse["receipt"].get("container_id"),
        "frontend_container_id": reuse["receipt"].get("frontend_container_id"),
        "frontend_host_inputs": str(reuse["frontend_inputs"]),
        "frontend_host_inputs_sha256": digest(reuse["frontend_inputs"]),
        "frontend_inputs": str(reuse["guest_inputs"]),
        "frontend_inputs_sha256": digest(reuse["guest_inputs"]),
        "previous_config_sha256": reuse.get("previous_config_sha256"),
    }
    attempt_path = history / "failed-attempt.json"
    storage.atomic_json(attempt_path, attempt)
    manifest = read_json(history / "manifest.json")
    manifest["failed_attempt"] = str(attempt_path)
    manifest["failed_attempt_sha256"] = digest(attempt_path)
    manifest["failed_attempt_state"] = "failed_preflight"
    manifest["service_mutation"] = "not_started"
    storage.atomic_json(history / "manifest.json", manifest)
    return attempt


def _preflight_reuse_frontend_inputs(repo, reuse, source_root, port):
    """Validate the reusable frontend seed before replacing its run receipt."""
    from docker_development_inputs import seed, select_checkout

    try:
        selected_checkout = select_checkout(repo, source_root)
        inputs = seed(
            selected_checkout,
            reuse["state"],
            port,
            reuse_from=reuse["frontend_inputs"],
        )
        if not isinstance(inputs, dict):
            raise ValueError("Frontend reuse seed returned a malformed input manifest")
    except Exception as error:
        try:
            _record_recreate_preflight_failure(
                reuse,
                phase="frontend-seed",
                error=error,
            )
        except Exception as evidence_error:
            raise RuntimeError(
                "Frontend reuse preflight failed and its evidence could not be preserved: "
                f"{evidence_error}; original error: {error}"
            ) from evidence_error
        raise
    return selected_checkout, inputs


def _publish_restart_sentinel(state, payload):
    """Atomically rotate the owned binary restart proof for a new image."""
    from windows_folder_host import _pinned_no_reparse_ancestors, _replace_write_through

    path = Path(state) / ".windows-folder-probe" / "restart-sentinel.bin"
    if path.is_symlink() or not path.is_file():
        raise ValueError("Reused Windows restart sentinel is missing or not a regular file")
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with _pinned_no_reparse_ancestors(path.parent):
            if path.is_symlink() or not path.is_file():
                raise ValueError("Reused Windows restart sentinel changed during rotation")
            with temporary.open("xb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            _replace_write_through(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _reuse_host_certificate(reuse, assembly, engine_id, *, development_build=None):
    """Rotate only the image fields of the existing owned Windows certificate."""
    from windows_folder_host import (
        HOST_SCHEMA,
        _validate_development_build,
        local_volume,
        publish_evidence,
    )

    delegated_build = (
        _validate_development_build(development_build)
        if development_build is not None else None
    )

    certificate = _read_reuse_json(reuse["host_certificate"], "Windows host certificate")
    marker = _read_reuse_json(reuse["owner_marker"], "Windows storage owner marker")
    if certificate != marker or certificate.get("schema") != HOST_SCHEMA:
        raise ValueError("Reused Windows storage certificate and owner marker differ")
    if (certificate.get("storage_profile") != "windows-folder-v1"
            or certificate.get("role") != "session"
            or certificate.get("owner_scope") != "docker-desktop-linux"):
        raise ValueError("Reused Windows storage certificate has the wrong ownership scope")
    owner = certificate.get("owner_token")
    try:
        parsed = uuid.UUID(str(owner))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("Reused Windows storage owner token is invalid") from error
    if parsed.int == 0 or str(parsed) != owner:
        raise ValueError("Reused Windows storage owner token is not canonical")
    native = local_volume(reuse["state"])
    for field in ("host_root", "host_filesystem", "host_drive_type", "host_volume_serial", "host_root_no_reparse"):
        if certificate.get(field) != native.get(field):
            raise ValueError("Reused Windows storage identity changed: " + field)
    if certificate.get("image_id") != reuse["receipt"].get("image_id"):
        raise ValueError("Reused Windows certificate image does not match its run receipt")
    if not isinstance(engine_id, str) or not engine_id or certificate.get("engine_id") != engine_id:
        raise ValueError("Reused Windows storage certificate belongs to another Docker engine")
    rotated = dict(certificate)
    rotated.update(
        image_id=assembly["image_id"],
        source_commit=assembly["commit"],
        binary_hashes=assembly["binary_hashes"],
        artifact_receipt_sha256=assembly["build_receipt_sha256"],
        restart_expected_sha256=hashlib.sha256(
            (owner + ":" + assembly["image_id"]).encode("ascii")
        ).hexdigest(),
        restart_verified=False,
    )
    if delegated_build is not None:
        rotated["development_build"] = delegated_build
    _publish_restart_sentinel(
        reuse["state"],
        (owner + ":" + assembly["image_id"]).encode("ascii"),
    )
    publish_evidence(reuse["host_certificate"], rotated)
    publish_evidence(reuse["owner_marker"], rotated)
    return rotated


def _validate_backend_start_inputs(value, layout):
    """Validate the host-owned pre-build descriptor before Compose mutation."""

    if not isinstance(value, dict) or value.get("schema") != "fullmag.direct-compose.backend-start-inputs.v1":
        raise ValueError("Backend start inputs have an unsupported schema")
    if value.get("state") != "ready" or value.get("source_mode") != "live-shadow-v1":
        raise ValueError("Backend start inputs are not ready live-source inputs")
    image = value.get("image_id")
    toolchain = value.get("toolchain_image_id")
    if not isinstance(image, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise ValueError("Backend start inputs have no immutable runtime image")
    if not isinstance(toolchain, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", toolchain):
        raise ValueError("Backend start inputs have no immutable toolchain image")
    toolchain_manifest = value.get("toolchain_manifest_sha256")
    if not isinstance(toolchain_manifest, str) or _CONFIG_SHA256_RE.fullmatch(toolchain_manifest) is None:
        raise ValueError("Backend start inputs have no pinned toolchain manifest")
    if value.get("cargo_profile") != "backend-dev" or value.get("build_profile") != "dev":
        raise ValueError("Backend start inputs are not the supported GPU development profile")
    source_group = {
        "source_project_id": value.get("source_project_id"),
        "source_worktree_id": value.get("source_worktree_id"),
        "source_checkout_kind": value.get("source_checkout_kind"),
    }
    if any(not isinstance(item, str) or not item for item in source_group.values()):
        raise ValueError("Backend start inputs have no complete source group identity")
    if any(not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,127}", item)
           for item in source_group.values()):
        raise ValueError("Backend start source group identity is invalid")
    for field in (
        "source_root", "git_common_dir", "provenance_path",
        "helper_context", "backend_start_receipt",
    ):
        item = value.get(field)
        if not isinstance(item, str) or not Path(item).is_absolute():
            raise ValueError(f"Backend start inputs have no absolute {field}")
    package_value = value.get("package_root")
    if not isinstance(package_value, str):
        raise ValueError("Backend start inputs have no package_root")
    try:
        package_daemon_path = PurePosixPath(package_value)
    except (TypeError, ValueError) as error:
        raise ValueError("Backend start package_root is malformed") from error
    if not package_daemon_path.is_absolute() or any(
        part in {"", ".", ".."} for part in package_daemon_path.parts[1:]
    ):
        raise ValueError("Backend start package_root is not a safe daemon path")
    # Fresh starts intentionally do not carry a host-captured source snapshot.
    # If an older caller supplies the complete identity, validate it as an
    # admission pin; otherwise the backend receipt is the sole source authority.
    identity_fields = ("resolved_commit", "source_digest", "source_snapshot_sha256",
                       "live_manifest_sha256", "native_source_identity")
    supplied_identity = [value.get(field) for field in identity_fields]
    if any(item is not None for item in supplied_identity):
        if not all(item is not None for item in supplied_identity):
            raise ValueError("Backend start source identity is incomplete")
        commit = value["resolved_commit"]
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("Backend start source commit is invalid")
        for field in ("source_digest", "source_snapshot_sha256", "live_manifest_sha256"):
            item = value[field]
            if not isinstance(item, str) or _CONFIG_SHA256_RE.fullmatch(item) is None:
                raise ValueError(f"Backend start source identity is invalid: {field}")
        native = value["native_source_identity"]
        if not isinstance(native, dict) or native.get("head_commit_full") != commit:
            raise ValueError("Backend start native source identity differs from its commit")
    source_manifest = value.get("source_manifest")
    if source_manifest is not None and (
        not isinstance(source_manifest, str) or not Path(source_manifest).is_absolute()
    ):
        raise ValueError("Backend start source manifest path is invalid")
    for field in ("provenance_path", "backend_start_receipt"):
        path = Path(value[field])
        if path.is_symlink() or not path.exists():
            raise ValueError(f"Backend start {field} is missing or a reparse point")
    provenance = Path(value["provenance_path"])
    if provenance.is_symlink() or not provenance.is_file():
        raise ValueError("Backend start provenance handoff is not a regular file")
    helpers = value.get("startup_helper_hashes")
    if (not isinstance(helpers, dict) or set(helpers) != {"docker_startup_script.py", "fullmag_storage.py"}
            or any(not isinstance(item, str) or _CONFIG_SHA256_RE.fullmatch(item) is None
                   for item in helpers.values())):
        raise ValueError("Backend start inputs have no complete startup helper inventory")
    cache = value.get("backend_cache")
    if not isinstance(cache, dict) or cache.get("state") != "ready":
        raise ValueError("Backend start inputs have no ready backend cache profile")
    cache_package = cache.get("package_root")
    cache_mount = cache.get("mount_root")
    cache_environment = cache.get("environment")
    if (not isinstance(cache_package, str) or not isinstance(cache_mount, str)
            or not isinstance(cache_environment, dict)
            or cache_package != value.get("package_root")
            or cache_environment.get("FULLMAG_BACKEND_PACKAGE") != cache_package):
        raise ValueError("Backend start package is not the cache helper's typed package root")
    cache_kind, _cache_adapter = _backend_cache_kind(cache)
    if cache_kind == "v2":
        _validate_backend_volume_cache(cache, expected_package=cache_package)
        if package_daemon_path != PurePosixPath(_cache_adapter.PACKAGE_TARGET):
            raise ValueError("Backend start v2 package root is not the canonical daemon target")
    else:
        try:
            cache_package_path = PurePosixPath(cache_package)
            cache_mount_path = PurePosixPath(cache_mount)
            relative = cache_package_path.relative_to(cache_mount_path)
        except ValueError as error:
            raise ValueError("Backend start package escapes the attested backend cache mount") from error
        if (not cache_package_path.is_absolute() or not cache_mount_path.is_absolute()
                or relative != PurePosixPath("package")
                or cache_package_path != package_daemon_path):
            raise ValueError("Backend start package is not the attested daemon package child")
    previous_receipt = value.get("previous_backend_build_receipt_sha256")
    if previous_receipt is not None and (
        not isinstance(previous_receipt, str) or _CONFIG_SHA256_RE.fullmatch(previous_receipt) is None
    ):
        raise ValueError("Backend start previous receipt identity is invalid")
    return value


def _validate_backend_start_source_group(backend_start, source_identity):
    """Bind backend-start labels to the canonical Compose identity fields."""

    for backend_field, identity_field in (
        ("source_project_id", "project_id"),
        ("source_worktree_id", "worktree_id"),
        ("source_checkout_kind", "checkout_kind"),
    ):
        if backend_start[backend_field] != source_identity[identity_field]:
            raise ValueError("Backend start source group differs from the selected checkout")


def _daemon_mount_path(value, label):
    """Validate one daemon-namespace mount path without host resolution."""

    try:
        path = PurePosixPath(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} is not a valid daemon path") from error
    if (not path.is_absolute()
            or any(part in {"", ".", ".."} for part in path.parts[1:])):
        raise ValueError(f"{label} is not a canonical daemon path")
    return path


_BACKEND_BUILD_DOCUMENTS_SCRIPT = r'''
import hashlib
import json
import os
import stat

MAXIMUM = 16 * 1024 * 1024
FLAGS = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)


def read(path):
    descriptor = os.open(path, FLAGS)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise RuntimeError("build handoff is not one regular file")
        if metadata.st_size <= 0 or metadata.st_size > MAXIMUM:
            raise RuntimeError("build handoff exceeds its size bound")
        chunks = bytearray()
        while len(chunks) <= MAXIMUM:
            block = os.read(descriptor, min(1024 * 1024, MAXIMUM + 1 - len(chunks)))
            if not block:
                break
            chunks.extend(block)
        if len(chunks) > MAXIMUM:
            raise RuntimeError("build handoff exceeds its size bound")
        raw = bytes(chunks)
        return {"value": json.loads(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    finally:
        os.close(descriptor)


print(json.dumps({
    "receipt": read("/opt/fullmag/package/backend-build-receipt.json"),
    "provenance": read("/opt/fullmag/provenance.json"),
}, separators=(",", ":")))
'''


_BACKEND_BINARY_DIGESTS_SCRIPT = r'''
import hashlib
import json
import os
import stat
import sys

FLAGS = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
MAXIMUM = 16 * 1024 * 1024 * 1024
result = {}
for name in sys.argv[1:]:
    path = "/opt/fullmag/package/bin/" + name
    descriptor = os.open(path, FLAGS)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise RuntimeError("runtime artifact is not one regular file")
        digest = hashlib.sha256()
        total = 0
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > MAXIMUM:
                raise RuntimeError("runtime artifact exceeds its size bound")
            digest.update(block)
        result[name] = digest.hexdigest()
    finally:
        os.close(descriptor)
print(json.dumps(result, sort_keys=True, separators=(",", ":")))
'''


def _read_backend_binary_hashes(inputs, container_id):
    """Hash published binaries inside the daemon package mount."""

    cache = inputs.get("backend_cache") if isinstance(inputs, Mapping) else None
    cache_kind = _backend_cache_kind(cache)[0] if isinstance(cache, dict) else None
    package_path = None if cache_kind == "v2" else Path(str(inputs["package_root"]))
    if package_path is not None and package_path.is_dir():
        return {
            name: digest(package_path / "bin" / name)
            for name in REQUIRED_BINARIES
        }
    if not container_id:
        raise ValueError("Backend package is daemon-owned and has no running container for attestation")
    try:
        raw = docker(
            "exec", container_id, "/usr/local/bin/python3", "-c",
            _BACKEND_BINARY_DIGESTS_SCRIPT, *REQUIRED_BINARIES, timeout=120,
        )
        value = json.loads(raw)
    except DockerOutcomeUnknown:
        raise
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("Backend container binary attestation returned invalid JSON") from error
    if (not isinstance(value, dict)
            or set(value) != set(REQUIRED_BINARIES)
            or any(not isinstance(item, str) or _CONFIG_SHA256_RE.fullmatch(item) is None
                   for item in value.values())):
        raise ValueError("Backend container binary attestation is incomplete")
    return value


def _read_backend_build_documents(inputs, container_id):
    """Read package/provenance from the daemon mount or local test fixture."""

    cache = inputs.get("backend_cache") if isinstance(inputs, Mapping) else None
    cache_kind = _backend_cache_kind(cache)[0] if isinstance(cache, dict) else None
    package_path = None if cache_kind == "v2" else Path(str(inputs["package_root"]))
    if package_path is not None and package_path.is_dir():
        receipt_path = package_path / "backend-build-receipt.json"
        provenance_path = Path(inputs["provenance_path"])
        if not receipt_path.exists() or receipt_path.is_symlink():
            return None
        try:
            receipt = _read_reuse_json(
                receipt_path, "backend build receipt", maximum=16 * 1024 * 1024
            )
            provenance = _read_reuse_json(
                provenance_path, "backend runtime provenance", maximum=16 * 1024 * 1024
            )
        except (OSError, ValueError):
            return None
        return receipt, provenance, digest(receipt_path)
    if not container_id:
        return None
    try:
        raw = docker(
            "exec", container_id, "/usr/local/bin/python3", "-c",
            _BACKEND_BUILD_DOCUMENTS_SCRIPT, timeout=30,
        )
        observed = json.loads(raw)
        receipt_record = observed.get("receipt")
        provenance_record = observed.get("provenance")
        if (not isinstance(receipt_record, dict) or not isinstance(provenance_record, dict)
                or not isinstance(receipt_record.get("value"), dict)
                or not isinstance(provenance_record.get("value"), dict)
                or not isinstance(receipt_record.get("sha256"), str)):
            return None
        return (
            receipt_record["value"],
            provenance_record["value"],
            receipt_record["sha256"],
        )
    except DockerOutcomeUnknown:
        raise
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _wait_for_backend_build(inputs, container_id, *, timeout):
    """Observe the fixed backend service's final receipt before host attestation."""

    deadline = time.monotonic() + timeout
    while True:
        observed_documents = _read_backend_build_documents(inputs, container_id)
        if observed_documents is not None:
            receipt, provenance, receipt_digest = observed_documents
            if receipt.get("state") in {"failed", "failed_resources_retained"}:
                raise ValueError("Backend service published a failed build receipt")
            if (receipt.get("schema") == "fullmag.direct-compose.backend-build-receipt.v1"
                    and receipt.get("state") == "succeeded"
                    and provenance.get("state") == "succeeded"):
                previous_digest = inputs.get("previous_backend_build_receipt_sha256")
                if (receipt_digest != previous_digest
                        and provenance.get("build_receipt_sha256") == receipt_digest):
                    return receipt, provenance
        if container_id:
            document = _container_inspect(container_id)
            state = document.get("State")
            if isinstance(state, dict) and state.get("Running") is False:
                raise ValueError("Backend service exited before publishing final build provenance")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DockerOutcomeUnknown(["backend-build", str(container_id or "unknown")], timeout)
        time.sleep(min(0.25, remaining))


def _assembly_from_backend_start(inputs, receipt, provenance, *, container_id=None):
    """Map the backend's post-build provenance into the existing runtime contract."""

    binary_hashes = provenance.get("binary_hashes")
    if not isinstance(binary_hashes, dict) or set(binary_hashes) != set(REQUIRED_BINARIES):
        raise ValueError("Backend runtime provenance has no complete binary inventory")
    observed_binary_hashes = _read_backend_binary_hashes(inputs, container_id)
    for name, expected in binary_hashes.items():
        if not isinstance(expected, str) or _CONFIG_SHA256_RE.fullmatch(expected) is None:
            raise ValueError("Backend runtime provenance has an invalid binary digest")
        observed = observed_binary_hashes.get(name)
        if observed != expected:
            raise ValueError("Backend package differs from its post-build provenance: " + name)
    # A fresh service start has no host-captured source identity.  In that
    # mode the backend's successful receipt/provenance is authoritative; an
    # older descriptor may still provide all fields as an admission pin.
    admitted_fields = {
        "commit": inputs.get("resolved_commit"),
        "source_digest": inputs.get("source_digest"),
        "source_snapshot_sha256": inputs.get("source_snapshot_sha256"),
        "source_mode": inputs.get("source_mode"),
    }
    for field, admitted in admitted_fields.items():
        if admitted is not None and provenance.get(field) != admitted:
            raise ValueError("Backend runtime provenance differs from the admitted source identity: " + field)
    receipt_source = receipt.get("source")
    if not isinstance(receipt_source, dict):
        raise ValueError("Backend build receipt has no source identity")
    receipt_identity = {
        "commit": receipt_source.get("resolved_commit"),
        "source_digest": receipt_source.get("source_digest"),
        "source_snapshot_sha256": receipt_source.get("source_snapshot_sha256"),
        "source_mode": receipt_source.get("source_mode"),
        "live_manifest_sha256": receipt_source.get("live_manifest_sha256"),
    }
    if (not isinstance(receipt_identity["commit"], str)
            or not re.fullmatch(r"[0-9a-f]{40}", receipt_identity["commit"])
            or any(not isinstance(receipt_identity[field], str)
                   or _CONFIG_SHA256_RE.fullmatch(receipt_identity[field]) is None
                   for field in ("source_digest", "source_snapshot_sha256", "live_manifest_sha256"))
            or receipt_identity["source_mode"] != "live-shadow-v1"):
        raise ValueError("Backend build receipt has incomplete live source identity")
    for field in ("commit", "source_digest", "source_snapshot_sha256", "source_mode"):
        if provenance.get(field) != receipt_identity[field]:
            raise ValueError("Backend receipt and runtime provenance differ: " + field)
    receipt_native = receipt.get("native_source_identity")
    if not isinstance(receipt_native, dict) or provenance.get("native_source_identity") != receipt_native:
        raise ValueError("Backend receipt and runtime provenance differ: native source identity")
    if provenance.get("toolchain_image_id") != inputs["toolchain_image_id"]:
        raise ValueError("Backend runtime provenance differs from the admitted toolchain image")
    assembly = {
        "schema": "fullmag.docker-all-image.v1",
        "state": "succeeded",
        "exit_code": 0,
        "qualification": "NOT VERIFIED",
        "build_kind": "direct-compose",
        "direct_source_provenance": "fullmag.docker-backend-live-source.v1",
        "direct_build_id": inputs["run_id"],
        "commit": provenance["commit"],
        "source_mode": provenance["source_mode"],
        "source_root": inputs["source_root"],
        "source_digest": provenance["source_digest"],
        "source_snapshot_sha256": provenance["source_snapshot_sha256"],
        "native_source_identity": provenance["native_source_identity"],
        "source_git_common_dir": inputs["git_common_dir"],
        "image_id": inputs["image_id"],
        "base_image": inputs["toolchain_image_id"],
        "toolchain_image_id": inputs["toolchain_image_id"],
        "development_base_image": inputs.get("development_base_image"),
        "development_base_image_id": inputs.get("development_base_image_id"),
        "runtime_mode": "development_source_bind",
        "build_profile": inputs["build_profile"],
        "cargo_profile": provenance.get("cargo_profile"),
        "cargo_target_profile_dir": provenance.get("cargo_target_profile_dir"),
        "package_root": inputs["package_root"],
        "binary_hashes": binary_hashes,
        "startup_helper_hashes": inputs["startup_helper_hashes"],
        "build_receipt_sha256": provenance["build_receipt_sha256"],
        "backend_build_receipt": str(Path(inputs["package_root"]) / "backend-build-receipt.json"),
        "backend_build_receipt_schema": receipt.get("schema"),
        "output": str(Path(inputs["backend_start_receipt"]).parent),
        "context": inputs["helper_context"],
    }
    source_manifest = inputs.get("source_manifest")
    if source_manifest is not None:
        assembly["source_manifest"] = source_manifest
    assembly["live_manifest_sha256"] = receipt_identity["live_manifest_sha256"]
    return assembly


def _backend_assembly_receipt_identity(assembly):
    """Return compiled source fields only from a succeeded backend assembly."""

    if not isinstance(assembly, dict) or assembly.get("state") != "succeeded" \
            or assembly.get("exit_code") != 0:
        raise ValueError("Backend assembly is not a successful compiled receipt")
    commit = assembly.get("commit")
    native = assembly.get("native_source_identity")
    source_digest = assembly.get("source_digest")
    source_snapshot = assembly.get("source_snapshot_sha256")
    live_manifest = assembly.get("live_manifest_sha256")
    if (not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit)
            or not isinstance(native, dict)
            or not isinstance(source_digest, str) or not _CONFIG_SHA256_RE.fullmatch(source_digest)
            or not isinstance(source_snapshot, str) or not _CONFIG_SHA256_RE.fullmatch(source_snapshot)
            or not isinstance(live_manifest, str) or not _CONFIG_SHA256_RE.fullmatch(live_manifest)):
        raise ValueError("Backend assembly has incomplete compiled source identity")
    return {
        "compiled_source_commit": commit,
        "native_source_identity": native,
        "source_digest": source_digest,
        "source_snapshot_sha256": source_snapshot,
        "live_manifest_sha256": live_manifest,
    }


def _provisional_development_certificate(inputs, source_identity):
    """Return the pre-build certificate and delegation for the backend gate.

    The backend service must be able to run the guest storage probes before a
    package receipt exists.  The provisional values are deliberately unusable
    as a release identity.  The development delegation is a bootstrap audit
    bound to this immutable image/toolchain and selected Compose group; the
    live backend receipt remains authoritative for later builds.
    """

    binary_hashes = {name: _PROVISIONAL_DIGEST for name in REQUIRED_BINARIES}
    project = source_identity.get("project_name")
    if not isinstance(project, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise ValueError("Development host certificate has no valid Compose project identity")
    delegation = {
        "schema": _DEVELOPMENT_BUILD_SCHEMA,
        "cargo_profile": "backend-dev",
        "toolchain_image_id": inputs["toolchain_image_id"],
        "package_root": "/opt/fullmag/package",
        "provenance_path": "/opt/fullmag/provenance.json",
        "group_identity": project,
        "source_identity": {
            "commit": _PROVISIONAL_COMMIT,
            "source_digest": _PROVISIONAL_DIGEST,
            "source_snapshot_sha256": _PROVISIONAL_DIGEST,
            "native_source_identity_sha256": _PROVISIONAL_DIGEST,
        },
    }
    assembly = {
        "image_id": inputs["image_id"],
        "commit": _PROVISIONAL_COMMIT,
        "build_receipt_sha256": _PROVISIONAL_DIGEST,
    }
    return assembly, binary_hashes, delegation


def _refresh_development_certificate(certificate, assembly, inputs):
    """Bind the first live build receipt while retaining the bootstrap delegation."""

    refreshed = dict(certificate)
    refreshed.update(
        source_commit=assembly["commit"],
        binary_hashes=dict(assembly["binary_hashes"]),
        artifact_receipt_sha256=assembly["build_receipt_sha256"],
        restart_verified=False,
    )
    delegation = refreshed.get("development_build")
    if not isinstance(delegation, dict):
        raise ValueError("Initial development host certificate has no delegation")
    expected_fields = {
        "schema", "cargo_profile", "toolchain_image_id", "package_root",
        "provenance_path", "group_identity", "source_identity",
    }
    if set(delegation) != expected_fields:
        raise ValueError("Initial development host certificate has an invalid delegation")
    source_identity = delegation.get("source_identity")
    if not isinstance(source_identity, dict) or set(source_identity) != {
        "commit", "source_digest", "source_snapshot_sha256", "native_source_identity_sha256",
    }:
        raise ValueError("Initial development host certificate has an invalid source audit")
    for field in ("commit", "source_digest", "source_snapshot_sha256", "native_source_identity_sha256"):
        if not isinstance(source_identity[field], str):
            raise ValueError("Initial development host certificate has an invalid source audit")
    if source_identity == {
        "commit": _PROVISIONAL_COMMIT,
        "source_digest": _PROVISIONAL_DIGEST,
        "source_snapshot_sha256": _PROVISIONAL_DIGEST,
        "native_source_identity_sha256": _PROVISIONAL_DIGEST,
    }:
        commit = assembly.get("commit")
        source_digest = assembly.get("source_digest")
        source_snapshot = assembly.get("source_snapshot_sha256")
        native = assembly.get("native_source_identity")
        if (not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit)
                or not isinstance(source_digest, str) or not _CONFIG_SHA256_RE.fullmatch(source_digest)
                or not isinstance(source_snapshot, str) or not _CONFIG_SHA256_RE.fullmatch(source_snapshot)
                or not isinstance(native, dict) or native.get("head_commit_full") != commit):
            raise ValueError("Backend assembly has no complete source audit for development delegation")
        native_source_identity_sha256 = hashlib.sha256(
            (json.dumps(native, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n")
            .encode("utf-8")
        ).hexdigest()
        updated_delegation = dict(delegation)
        updated_delegation["source_identity"] = {
            "commit": commit,
            "source_digest": source_digest,
            "source_snapshot_sha256": source_snapshot,
            "native_source_identity_sha256": native_source_identity_sha256,
        }
        refreshed["development_build"] = updated_delegation
    # Once populated, this audit is retained for provenance only.  The live
    # receipt/provenance remains authoritative and is never pinned to it on a
    # later ordinary backend restart.
    return refreshed


def _publish_bound_development_certificate(host_certificate, owner_marker, certificate):
    """Update the mounted certificate inode, then atomically rotate its marker."""

    from windows_folder_host import publish_evidence, write_bound_evidence

    write_bound_evidence(host_certificate, certificate)
    publish_evidence(owner_marker, certificate)


def _complete_backend_storage_preflight(docker_client, container_id, state, host_certificate, certificate, root):
    """Run the two guest storage observations without creating a third service."""

    logs = []
    for number in ("first", "restart"):
        output = docker_client(
            "exec", container_id, "/usr/local/bin/python3", "/opt/fullmag/entrypoint.py",
            "--storage-probe", timeout=120, combined=True,
        )
        logs.append(output)
    (Path(root) / "storage-probe.log").write_text("\n".join(logs), encoding="utf-8")
    from windows_folder_host import local_volume, publish_evidence, read_owned_regular, write_bound_evidence

    probe_path = Path(state) / ".windows-folder-probe" / "probe-restart.json"
    if not probe_path.is_file() or probe_path.is_symlink():
        raise ValueError("Backend storage preflight did not publish a restart probe")
    probe = json.loads(read_owned_regular(probe_path))
    checks = (
        "file_sync", "directory_sync", "atomic_replace", "atomic_directory_publish",
        "process_lock", "no_follow_symlink", "no_follow_junction",
        "sqlite_transactions", "restart_readback",
    )
    if (not isinstance(probe, dict) or set(probe.get("checks", {})) != set(checks)
            or not all(probe["checks"].values())):
        raise ValueError("Backend storage preflight checks were not all successful")
    sentinel = Path(state) / ".windows-folder-probe" / "restart-sentinel.bin"
    if hashlib.sha256(read_owned_regular(sentinel)).hexdigest() != certificate["restart_expected_sha256"]:
        raise ValueError("Backend storage restart sentinel differs from host attestation")
    for key, value in local_volume(state).items():
        if certificate.get(key) != value:
            raise ValueError("Native Windows volume identity changed during backend preflight: " + key)
    certificate["restart_verified"] = True
    publish_evidence(Path(state) / ".fullmag-windows-folder-owner.json", certificate)
    write_bound_evidence(host_certificate, certificate)
    return probe["checks"]


def _legacy_storage_preflight(configured, spec, compose_args, docker_client, root, state,
                              host_certificate, certificate):
    """Retain the static/assembly storage probe contract."""

    probe_service = configured["services"]["backend"]
    probe_service["command"] = ["--storage-probe"]
    probe_service["healthcheck"] = {"disable": True}
    storage.atomic_json(spec, configured)
    docker_client(*compose_args, "config", "--quiet")
    docker_client(*compose_args, "up", "--detach", "--no-build", "--pull", "never", "backend")
    probe_container = docker_client(*compose_args, "ps", "--all", "--quiet", "backend")
    first_exit = docker_client("wait", probe_container, timeout=120)
    (Path(root) / "storage-first.log").write_text(
        docker_client("logs", probe_container, combined=True), encoding="utf-8"
    )
    if first_exit != "0":
        raise ValueError("Windows storage first probe failed: " + docker_client(
            "logs", probe_container, combined=True
        ))
    docker_client("start", probe_container)
    restart_exit = docker_client("wait", probe_container, timeout=120)
    (Path(root) / "storage-restart.log").write_text(
        docker_client("logs", probe_container, combined=True), encoding="utf-8"
    )
    if restart_exit != "0":
        raise ValueError("Windows storage restart probe failed: " + docker_client(
            "logs", probe_container, combined=True
        ))
    from windows_folder_host import local_volume, read_owned_regular

    probe = json.loads(read_owned_regular(
        Path(state) / ".windows-folder-probe/probe-restart.json"
    ))
    checks = (
        "file_sync", "directory_sync", "atomic_replace", "atomic_directory_publish",
        "process_lock", "no_follow_symlink", "no_follow_junction",
        "sqlite_transactions", "restart_readback",
    )
    if set(probe["checks"]) != set(checks) or not all(probe["checks"].values()):
        raise ValueError("Windows session storage probes were not all successful")
    if hashlib.sha256(read_owned_regular(
            Path(state) / ".windows-folder-probe/restart-sentinel.bin"
    )).hexdigest() != certificate["restart_expected_sha256"]:
        raise ValueError("Native Windows restart readback differs from the guest")
    if any(certificate[key] != value for key, value in local_volume(state).items()):
        raise ValueError("Native Windows volume identity changed during preflight")
    certificate["restart_verified"] = True
    from windows_folder_host import publish_evidence
    publish_evidence(Path(state) / ".fullmag-windows-folder-owner.json", certificate)
    publish_evidence(host_certificate, certificate)
    return probe["checks"]


def start(repo, assembly_receipt, port, frontend="static", source_root=None,
          startup_script=None, *, project_name=None, compose_template=None,
          run_receipt=None, previous_config_sha256=None,
          recovery_authorization=None, migrate_compose_project=False,
          backend_start=None):
    if project_name is not None and not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project_name):
        raise ValueError("Invalid Compose project name")
    if (assembly_receipt is None) == (backend_start is None):
        raise ValueError("Exactly one of an assembly receipt or backend start inputs is required")
    if backend_start is not None and recovery_authorization is not None:
        raise ValueError("Backend start inputs cannot be combined with native recovery authorization")
    if backend_start is not None and source_root is None and isinstance(backend_start, dict):
        recorded_source = backend_start.get("source_root")
        if isinstance(recorded_source, str):
            source_root = Path(recorded_source)
    if not 1024 <= port <= 65535:
        raise ValueError("Port must be between 1024 and 65535")
    if frontend not in {"static", "dev"}:
        raise ValueError("Frontend mode must be static or dev")
    layout = storage.resolve_layout(repo, PROFILE)
    # A selected worktree owns its own build/run/history namespace.  For
    # recreate without --source-root, read the explicitly named receipt only
    # to discover that registered checkout; _load_reuse_run still validates the
    # receipt containment, schema, owner and stopped containers below.
    if source_root is not None:
        layout = storage.resolve_layout(Path(source_root).resolve(strict=True), PROFILE)
    elif run_receipt is not None:
        preliminary = _read_reuse_json(Path(run_receipt), "Docker runtime run receipt")
        recorded_source = preliminary.get("frontend_source_root") or preliminary.get("source_root")
        if isinstance(recorded_source, str) and recorded_source:
            layout = storage.resolve_layout(Path(recorded_source).resolve(strict=True), PROFILE)
    reuse = _load_reuse_run(
        layout,
        run_receipt,
        project_name=project_name,
        frontend=frontend,
        previous_config_sha256=previous_config_sha256,
        allow_failed_resources_retained=recovery_authorization is not None,
    )
    if run_receipt is not None and previous_config_sha256 is None:
        raise ValueError("--run-receipt reuse requires --previous-config-sha256")
    if previous_config_sha256 is not None and reuse is None:
        raise ValueError("Previous runtime configuration digest requires --run-receipt reuse")
    recovery_info = None
    if recovery_authorization is not None:
        if reuse is None:
            raise ValueError("--recover-idle-failure requires --run-receipt reuse")
        if previous_config_sha256 is None:
            raise ValueError("--recover-idle-failure requires --previous-config-sha256")
        from docker_runtime_recovery import (
            mount_attestation_path_for_receipt,
            validate_authorization,
        )

        recovery_info = validate_authorization(
            Path(recovery_authorization),
            run_receipt_path=reuse["receipt_path"],
            run_receipt=reuse["receipt"],
            state_root=reuse["state"],
            config_path=reuse["state"] / RUNTIME_CONFIG_RELATIVE,
            host_certificate_path=reuse["host_certificate"],
            mount_attestation_path=mount_attestation_path_for_receipt(
                reuse["root"], reuse["receipt"]
            ),
        )
        if recovery_info["authorization"].get("config_sha256") != previous_config_sha256:
            raise ValueError("Recovery authorization configuration pin differs from --previous-config-sha256")
    if reuse is not None:
        if source_root is None:
            source_root = reuse["source_root"]
        elif Path(source_root).resolve(strict=True) != reuse["source_root"]:
            raise ValueError("Requested live source checkout differs from the reused run")
    source_layout = storage.resolve_layout(Path(source_root).resolve(strict=True) if source_root is not None else repo, PROFILE)
    if reuse is None:
        layout = source_layout
    elif layout["worktree_id"] != source_layout["worktree_id"]:
        raise ValueError("Reused run storage identity differs from the selected source checkout")
    from docker_compose_identity import compose_project_identity
    source_identity = compose_project_identity(source_layout)
    expected_project = source_identity["project_name"]
    if project_name is not None:
        requested_project = reuse["project"] if reuse is not None else expected_project
        if project_name != requested_project:
            raise ValueError("Requested Compose project does not match the selected source checkout")
    project, source_identity, identity_compatibility = _select_reuse_compose_identity(
        source_identity, expected_project, reuse
    )
    if migrate_compose_project:
        project, source_identity, identity_compatibility = _select_migration_compose_identity(
            source_identity, expected_project, reuse
        )
        # This check covers every container state and the deterministic
        # project network. It is deliberately read-only: migration never
        # stops or removes a conflicting target instance.
        _assert_compose_project_absent(project, source_identity)
    backend_start = (
        _validate_backend_start_inputs(backend_start, layout)
        if backend_start is not None else None
    )
    if backend_start is not None:
        _validate_backend_start_source_group(backend_start, source_identity)
    if backend_start is None:
        assembly_receipt = storage.validate_path(assembly_receipt, Path(layout["build_storage_root"]))
        assembly = read_json(assembly_receipt)
        if assembly.get("schema") != "fullmag.docker-all-image.v1" or assembly.get("state") != "succeeded" or assembly.get("exit_code") != 0:
            raise ValueError("A successful all-in-Docker assembly receipt is required")
        source_provenance = _validate_assembly_source_provenance(assembly, frontend=frontend)
    else:
        source_provenance = {"source_mode": backend_start["source_mode"]}
        for field in ("source_digest", "source_snapshot_sha256", "live_manifest_sha256"):
            if backend_start.get(field) is not None:
                source_provenance[field] = backend_start[field]
        assembly = {
            "schema": "fullmag.docker-all-image.v1",
            "state": "building",
            "exit_code": 0,
            "runtime_mode": "development_source_bind",
            "source_mode": backend_start["source_mode"],
            "source_root": backend_start["source_root"],
            "source_git_common_dir": backend_start["git_common_dir"],
            "image_id": backend_start["image_id"],
            "base_image": backend_start["toolchain_image_id"],
            "toolchain_image_id": backend_start["toolchain_image_id"],
            "package_root": backend_start["package_root"],
            "startup_helper_hashes": backend_start["startup_helper_hashes"],
            "output": str(Path(backend_start["backend_start_receipt"]).parent),
            "context": backend_start["helper_context"],
        }
    image = assembly.get("image_id", "")
    observed = image_id(image)
    validate_workspace_environment(observed["Config"])
    helper_hashes = assembly.get("startup_helper_hashes")
    if (not isinstance(helper_hashes, dict)
            or set(helper_hashes) != {"docker_startup_script.py", "fullmag_storage.py"}
            or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
                   for value in helper_hashes.values())):
        raise ValueError("Assembly receipt has no complete pinned startup helper inventory")
    if observed.get("Config", {}).get("Labels", {}).get("org.fullmag.runtime") != "docker-all-gpu-v1":
        raise ValueError("Image is not a Fullmag all-in-Docker GPU runtime")
    if frontend == "dev":
        if (assembly.get("runtime_mode") != "development_source_bind"
                or observed["Config"].get("Labels", {}).get("org.fullmag.development") != "source-bind-v1"):
            raise ValueError("Development requires a source-bind image without copied application sources")
        if backend_start is None:
            package = storage.validate_path(Path(assembly["package_root"]), Path(layout["storage_root"]))
            validate_runtime_artifacts(package, development=True)
            if any(digest(package / "bin" / name) != assembly["binary_hashes"].get(name)
                   for name in REQUIRED_BINARIES):
                raise ValueError("Mounted backend package changed since image assembly")
    elif assembly.get("runtime_mode") == "development_source_bind":
        raise ValueError("Static mode requires a packaged release image")
    assert_loopback_port_available(port, project)
    storage.initialize(layout)
    workspace_state_root = _workspace_user_data_root(layout, project)
    selected_checkout = None
    preflight_inputs = None
    if reuse is not None and frontend == "dev":
        # The reusable receipt is the active CAS pointer until the live
        # frontend metadata has been proven reusable.  In particular, do not
        # archive it and publish a replacement ``starting`` receipt before
        # this validation: a failed seed must leave an explicit retryable
        # stopped run rather than an unreusable failed pointer.
        selected_checkout, preflight_inputs = _preflight_reuse_frontend_inputs(
            repo,
            reuse,
            source_root,
            port,
        )
    if reuse is None:
        root = storage.validate_path(Path(layout["runs_root"]) / "docker-all" / uuid.uuid4().hex,
                                     Path(layout["build_storage_root"]))
        root.mkdir(parents=True, exist_ok=False, mode=0o700)
        state = root / "state"
        state.mkdir(mode=0o777)
        state.chmod(0o777)
        metadata_root = root
    else:
        _preserve_reuse_evidence(reuse)
        if recovery_info is not None:
            from docker_runtime_recovery import validate_preserved_evidence

            recovery_info["preserved_evidence"] = validate_preserved_evidence(
                recovery_info, reuse["history_root"]
            )
        root = reuse["root"]
        state = reuse["state"]
        metadata_root = reuse["metadata_root"]
    register_runtime_reference_root(layout, root)
    spec = root / "compose.json"
    host_certificate = root / "windows-folder-host.json"
    if backend_start is not None:
        # Keep a typed pointer in the run receipt while the fixed backend
        # service is still compiling.  It is replaced atomically by the final
        # post-build assembly after the host has validated its receipt.
        assembly_receipt = metadata_root / "backend-assembly.json"
        storage.atomic_json(assembly_receipt, assembly)
    receipt = {"schema": "fullmag.docker-all-run.v1", "state": "starting", "image_id": image,
               "compose_project": project, "compose_file": str(spec), "state_root": str(state),
               "source_project_id": source_identity["project_id"],
               "source_worktree_id": source_identity["worktree_id"],
               "source_checkout_kind": source_identity["checkout_kind"],
               "host_certificate": str(host_certificate),
               "workspace_state_root": str(workspace_state_root),
               "assembly_receipt": str(assembly_receipt), "assembly_receipt_sha256": digest(assembly_receipt),
               "source_mode": source_provenance["source_mode"],
               "url": f"http://localhost:{port}/workspace", "qualification": "NOT VERIFIED",
               "frontend_mode": frontend, "container_http_port": 8080 if frontend == "dev" else 8081}
    for field in ("native_source_identity", "source_digest", "source_snapshot_sha256"):
        if field in assembly:
            receipt[field] = assembly[field]
    if "live_manifest_sha256" in source_provenance:
        receipt["live_manifest_sha256"] = source_provenance["live_manifest_sha256"]
        receipt["source_git_common_dir"] = assembly["source_git_common_dir"]
        if "source_manifest" in assembly:
            receipt["source_manifest"] = assembly["source_manifest"]
    if backend_start is not None:
        receipt["backend_start_inputs"] = backend_start["backend_start_receipt"]
        receipt["backend_start_inputs_sha256"] = digest(Path(backend_start["backend_start_receipt"]).with_name("backend-start-inputs.json"))
        receipt["backend_build_state"] = "building"
    elif isinstance(assembly.get("source_archive"), dict):
        # Preserve the immutable legacy descriptor when one exists.  Live
        # source runs intentionally take the branch above and never invent a
        # tar/archive field.
        receipt["source_archive"] = assembly["source_archive"]
    if identity_compatibility is not None:
        receipt["compose_identity_compatibility"] = identity_compatibility
    if migrate_compose_project:
        receipt["migrated_from"] = reuse["project"]
    if reuse is not None:
        receipt.update(
            reused_from=str(reuse["receipt_path"]),
            reused_from_sha256=digest(reuse["receipt_path"]),
            reuse_history=str(reuse["history_root"]),
            reuse_token=reuse["reuse_token"],
            previous_config_sha256=previous_config_sha256,
        )
    storage.atomic_json(root / "receipt.json", receipt)
    inputs = None
    host_ledger = None
    frontend_cache = None
    startup = None
    recovery = None
    inputs_path = metadata_root / "development-inputs.json"
    if recovery_info is not None:
        recovery_overlay = metadata_root / "compose.recovery.json"
        _write_recovery_overlay(recovery_overlay, recovery_info["path"])
        recovery = {
            "authorization": recovery_info["authorization"],
            "authorization_path": str(recovery_info["path"]),
            "authorization_sha256": recovery_info["authorization_sha256"],
            "request_sha256": recovery_info["request_sha256"],
            "compose_overlay": str(recovery_overlay),
        }
        receipt["runtime_recovery"] = {
            "schema": "fullmag.docker-runtime-recovery-authorization.v1",
            "authorization": str(recovery_info["path"]),
            "authorization_sha256": recovery_info["authorization_sha256"],
            "request_id": recovery_info["request_id"],
            "request_sha256": recovery_info["request_sha256"],
            "preserved_evidence": recovery_info.get("preserved_evidence", {}),
            "state": "pending_native_recovery",
        }
        storage.atomic_json(root / "receipt.json", receipt)
    try:
        args = ["compose", "-f", str(spec), "--project-name", project]
        if frontend == "dev":
            from docker_development_inputs import guest_manifest, seed, select_checkout
            if reuse is not None:
                inputs = preflight_inputs
            else:
                selected_checkout = select_checkout(repo, source_root)
                inputs = seed(
                    selected_checkout,
                    state,
                    port,
                    reuse_from=None,
                )
            if reuse is not None:
                # frontend_dev freezes this manifest.  Reuse the original
                # host and guest bytes instead of creating a new freeze root.
                host_inputs_path = reuse["frontend_inputs"]
                inputs_path = reuse["guest_inputs"]
                receipt["frontend_inputs_reused"] = True
            else:
                host_inputs_path = metadata_root / "development-inputs-host.json"
                storage.atomic_json(host_inputs_path, inputs)
                storage.atomic_json(inputs_path, guest_manifest(inputs))
            receipt["frontend_host_inputs"] = str(host_inputs_path)
            receipt["frontend_host_inputs_sha256"] = digest(host_inputs_path)
            from local_runner.build_source import native_identity
            receipt["mounted_source_identity_at_start"] = native_identity(selected_checkout, "snapshot")
            receipt["source_selection"] = "live_windows_selected_checkout"
            receipt["source_root"] = inputs["source_root"]
            if backend_start is None:
                receipt["compiled_source_commit"] = assembly["commit"]
            receipt["frontend_source_root"] = inputs["source_root"]
            receipt["frontend_source_commit"] = inputs["source_commit"]
            receipt["frontend_observed_source_commit"] = storage.git(
                selected_checkout, "rev-parse", "HEAD"
            )
            receipt["frontend_inputs"] = str(inputs_path)
            receipt["frontend_inputs_sha256"] = digest(inputs_path)

        if startup_script is not None:
            from docker_development_inputs import select_checkout

            selected_source = (
                Path(inputs["source_root"])
                if inputs is not None
                else select_checkout(repo, source_root)
            )
            if inputs is None:
                _require_static_source_identity(assembly, selected_source)
            startup_helper, helper_attestation = _startup_helper_for_start(
                assembly, layout, selected_source
            )
            source_commit = (
                inputs.get("source_commit")
                if inputs is not None
                else storage.git(selected_source, "rev-parse", "HEAD")
            )
            startup_authorization = startup_helper.prepare(
                selected_source,
                startup_script,
                request_id="startup-" + root.name,
                source_commit=source_commit,
            )
            if inputs is not None and startup_authorization.source_root != Path(inputs["source_root"]).resolve():
                raise ValueError("Startup script checkout differs from the mounted development checkout")
            startup_provenance = metadata_root / "startup-provenance.json"
            provenance_sha256 = startup_helper.write_provenance(startup_provenance, startup_authorization)
            helper_hashes = assembly.get("startup_helper_hashes", {})
            helper_sha256 = helper_hashes.get("docker_startup_script.py")
            if not re.fullmatch(r"[0-9a-f]{64}", helper_sha256 or ""):
                raise ValueError("Assembly receipt has no pinned startup helper digest")
            startup_overlay = metadata_root / "compose.startup.json"
            authorization = startup_authorization.as_dict()
            _write_startup_overlay(
                startup_overlay,
                authorization,
                include_source=inputs is None,
                provenance_sha256=provenance_sha256,
                helper_sha256=helper_sha256,
            )
            startup = {"authorization": authorization, "compose_overlay": str(startup_overlay),
                       "provenance_sha256": provenance_sha256, "helper_sha256": helper_sha256}
            receipt["startup_script"] = {
                "source_relative": authorization["source_relative"],
                "source_sha256": authorization["source_sha256"],
                "source_size_bytes": authorization["source_size_bytes"],
                "source_commit": authorization["source_commit"],
                "source_root": authorization["source_root"],
                "source_path": authorization["source_path"],
                "container_script_path": authorization["container_script_path"],
                "request_id": authorization["request_id"],
                "helper_source": helper_attestation["source"],
                "helper_hashes_observed": helper_attestation["hashes"],
                "provenance": str(startup_provenance),
                "provenance_sha256": provenance_sha256,
                "helper_sha256": helper_sha256,
                "compose_overlay": str(startup_overlay),
                "execution_policy": authorization["execution_policy"],
            }

        source_template = (Path(compose_template) if compose_template is not None
                           else repo / ("compose.dev.yaml" if inputs is not None else "compose.static.yaml"))
        compose_source_path = metadata_root / "compose.source.yaml"
        if compose_source_path.exists() or compose_source_path.is_symlink():
            if compose_source_path.is_symlink() or compose_source_path.read_bytes() != source_template.read_bytes():
                raise ValueError("Reused Compose source template differs from the requested version")
        else:
            shutil.copyfile(source_template, compose_source_path)

        def configured_spec():
            package_provenance = (
                Path(backend_start["provenance_path"])
                if backend_start is not None else assembly_receipt
            )
            return compose_spec(image, state.resolve(), port, host_certificate.resolve(),
                                repo=repo, inputs=inputs, inputs_path=inputs_path.resolve(),
                                package=assembly.get("package_root"),
                                provenance=package_provenance, project=project, source_identity=source_identity,
                                workspace_state_root=workspace_state_root,
                                toolchain_image=assembly.get("base_image"), template=compose_source_path,
                                host_ledger=host_ledger, startup=startup,
                                frontend_cache=frontend_cache, recovery=recovery,
                                previous_config_sha256=previous_config_sha256,
                                backend_start=backend_start)
        if os.name != "nt":
            raise ValueError("This Windows-folder launcher requires native Windows host attestation")
        from windows_folder_host import attest, local_volume, publish_evidence, read_owned_regular
        from docker_host_ledger import prepare as prepare_host_ledger
        engine_id = docker("info", "--format", "{{.ID}}")
        if backend_start is not None:
            # The fixed backend service starts in a build gate.  Publish a
            # provisional development delegation before Compose creation so
            # its two guest probes can run while the package is compiling.
            host_certificate.parent.mkdir(parents=True, exist_ok=True)
            host_certificate.touch(exist_ok=True)
            provisional_assembly, provisional_hashes, delegation = (
                _provisional_development_certificate(backend_start, source_identity)
            )
            provisional_assembly = {
                **provisional_assembly,
                "binary_hashes": provisional_hashes,
            }
            if reuse is not None:
                # Reuse already has an attested probe directory and owner
                # marker.  Creating a fresh probe would collide with that
                # durable evidence and would also mint a second owner token.
                certificate = _reuse_host_certificate(
                    reuse,
                    provisional_assembly,
                    engine_id,
                    development_build=delegation,
                )
            else:
                certificate = attest(
                    state,
                    provisional_assembly,
                    engine_id,
                    provisional_hashes,
                    development_build=delegation,
                )
                publish_evidence(host_certificate, certificate)
        elif reuse is not None:
            certificate = _reuse_host_certificate(reuse, assembly, engine_id)
        else:
            certificate = None
        host_ledger = prepare_host_ledger(
            layout,
            repo,
            image,
            metadata_root / "host-ledger",
            docker,
        )
        receipt["host_ledger"] = host_ledger
        storage.atomic_json(root / "receipt.json", receipt)
        if inputs is not None:
            from docker_frontend_cache import prepare as prepare_frontend_cache

            frontend_cache = prepare_frontend_cache(
                layout,
                repo,
                image,
                metadata_root / "frontend-cache",
                docker,
                source_root=inputs["source_root"],
                worktree_id=inputs["worktree_id"],
                host_port=inputs["host_port"],
                dependency_seed_sha256=inputs["dependency_seed_sha256"],
                toolpins=inputs["toolpins"],
            )
            receipt["frontend_cache"] = {
                "schema": frontend_cache["schema"],
                "profile": frontend_cache["profile"],
                "cache_key": frontend_cache["cache_key"],
                "project_id": frontend_cache["project_id"],
                "filesystem_uuid": frontend_cache["filesystem_uuid"],
                "mount_root": frontend_cache["mount_root"],
                "children": frontend_cache["children"],
                "guest_targets": frontend_cache["guest_targets"],
                "helper_sha256": frontend_cache["helper_sha256"],
                "compose_overlay_sha256": frontend_cache["compose_overlay_sha256"],
                "receipt_path": frontend_cache["receipt_path"],
            }
            storage.atomic_json(root / "receipt.json", receipt)
        if certificate is None and backend_start is None:
            certificate = attest(state, assembly, engine_id, assembly["binary_hashes"])
        if certificate is not None:
            publish_evidence(host_certificate, certificate)
        if recovery_info is not None:
            from docker_runtime_recovery import validate_postrotation_identity

            if not isinstance(host_ledger, dict) or not isinstance(host_ledger.get("receipt"), str):
                raise ValueError("Fresh host-ledger preparation omitted its receipt path")
            postrotation = validate_postrotation_identity(
                recovery_info,
                history_root=reuse["history_root"],
                current_host_certificate_path=host_certificate,
                current_mount_attestation_path=Path(host_ledger["receipt"]),
                binding_path=metadata_root / "recovery-postrotation-binding.json",
            )
            recovery_info["postrotation_binding"] = postrotation
            receipt["runtime_recovery"].update(
                postrotation_binding_path=postrotation["path"],
                postrotation_binding_sha256=postrotation["sha256"],
            )
            storage.atomic_json(root / "receipt.json", receipt)
        receipt["compose_source"] = str(compose_source_path)
        receipt["compose_source_sha256"] = digest(compose_source_path)
        configured = configured_spec()
        if recovery_info is not None:
            if digest(recovery_info["path"]) != recovery_info["authorization_sha256"]:
                raise ValueError("Runtime recovery authorization changed before Compose publication")
            binding = recovery_info.get("postrotation_binding")
            if (not isinstance(binding, dict) or not isinstance(binding.get("path"), str)
                    or digest(Path(binding["path"])) != binding.get("sha256")):
                raise ValueError("Post-rotation storage identity binding changed before Compose publication")
        initial_service_ids = None
        if backend_start is not None:
            # The backend service stays alive in its typed build gate.  It is
            # the only application container that runs the two guest probes;
            # no third probe container is created.
            storage.atomic_json(spec, configured)
            docker(*args, "config", "--quiet")
            docker(*args, "up", "--detach", "--no-build", "--pull", "never")
            container = _compose_service_container_id(args, "backend")
            frontend_container = _compose_service_container_id(args, "frontend")
            initial_service_ids = {
                "backend": container,
                "frontend": frontend_container,
            }
            backend_receipt, backend_provenance = _wait_for_backend_build(
                backend_start, container, timeout=FRONTEND_DEV_READY_TIMEOUT_SECONDS
            )
            assembly = _assembly_from_backend_start(
                backend_start, backend_receipt, backend_provenance,
                container_id=container,
            )
            receipt.update(_backend_assembly_receipt_identity(assembly))
            receipt["source_git_common_dir"] = assembly["source_git_common_dir"]
            storage.atomic_json(assembly_receipt, assembly)
            receipt["assembly_receipt_sha256"] = digest(assembly_receipt)
            receipt["backend_build_state"] = "succeeded"
            receipt["backend_build_receipt_sha256"] = assembly["build_receipt_sha256"]
            if reuse is not None:
                certificate = _refresh_development_certificate(
                    certificate, assembly, backend_start
                )
                _publish_bound_development_certificate(
                    host_certificate,
                    state / ".fullmag-windows-folder-owner.json",
                    certificate,
                )
            else:
                if certificate is None:
                    raise ValueError("Development backend build has no provisional host certificate")
                certificate = _refresh_development_certificate(certificate, assembly, backend_start)
                _publish_bound_development_certificate(
                    host_certificate,
                    state / ".fullmag-windows-folder-owner.json",
                    certificate,
                )
            receipt["storage_operational_checks"] = _complete_backend_storage_preflight(
                docker, container, state, host_certificate, certificate, root
            )
            receipt["storage_power_loss"] = "NOT VERIFIED"
        else:
            receipt["storage_operational_checks"] = _legacy_storage_preflight(
                configured, spec, args, docker, root, state, host_certificate, certificate
            )
            receipt["storage_power_loss"] = "NOT VERIFIED"
        if recovery_info is not None:
            if digest(recovery_info["path"]) != recovery_info["authorization_sha256"]:
                raise ValueError("Runtime recovery authorization changed before service startup")
            binding = recovery_info.get("postrotation_binding")
            if (not isinstance(binding, dict) or not isinstance(binding.get("path"), str)
                    or digest(Path(binding["path"])) != binding.get("sha256")):
                raise ValueError("Post-rotation storage identity binding changed before service startup")
        storage.atomic_json(spec, configured_spec())
        ready_timeout, docker_client_timeout = _runtime_ready_timeouts(inputs, startup)
        docker(*args, "up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout",
               str(ready_timeout), timeout=docker_client_timeout)
        container = _compose_service_container_id(args, "backend")
        receipt["container_id"] = container
        if initial_service_ids is not None:
            frontend_container = _compose_service_container_id(args, "frontend")
            if container != initial_service_ids["backend"]:
                raise ValueError(
                    "Backend Compose container was recreated between build and readiness"
                )
            if frontend_container != initial_service_ids["frontend"]:
                raise ValueError(
                    "Frontend Compose container was recreated between build and readiness"
                )
        actual = json.loads(docker("inspect", container))[0]
        from docker_compose_identity import validate_source_labels
        validate_source_labels(actual, source_identity)
        from docker_host_ledger import validate_container as validate_host_ledger
        receipt["host_ledger_attestation"] = validate_host_ledger(actual, host_ledger, docker)
        bindings = {str(receipt["container_http_port"]) + "/tcp":
                    [{"HostIp": "127.0.0.1", "HostPort": str(port)}]}
        if inputs is not None:
            from docker_development_inputs import attest_mounts
            if initial_service_ids is None:
                frontend_container = _compose_service_container_id(args, "frontend")
            receipt["frontend_container_id"] = frontend_container
            front = json.loads(docker("inspect", frontend_container))[0]
            validate_source_labels(front, source_identity)
            attest_mounts(front, inputs, inputs_path)
            front_host = front["HostConfig"]
            if (front["Image"] != image or front_host.get("PortBindings") != bindings
                    or not front_host.get("ReadonlyRootfs") or front_host.get("Privileged")
                    or front["Config"].get("User") != "65532:65532"
                    or front_host.get("DeviceRequests")):
                raise ValueError("Frontend image, loopback port or isolation attestation mismatch")
            if frontend_cache is None:
                raise ValueError("Development frontend cache was not prepared before startup")
            from docker_frontend_cache import validate_container as validate_frontend_cache
            receipt["frontend_cache_attestation"] = validate_frontend_cache(front, frontend_cache)
            writable = [m for m in front["Mounts"] if m.get("RW") and m["Type"] == "bind"]
            expected_writable_targets = {"/state/development", *frontend_cache["guest_targets"].values()}
            actual_writable_targets = {mount["Destination"] for mount in writable}
            if actual_writable_targets != expected_writable_targets:
                raise ValueError("Frontend writable mounts must be the isolated state root and four cache binds")
            state_mounts = [mount for mount in writable if mount["Destination"] == "/state/development"]
            if (len(state_mounts) != 1 or host_path(state_mounts[0]["Source"]) != (state / "development").resolve()):
                raise ValueError("Frontend writable state mount must be its isolated development directory")
            bindings = {}
        from docker_compose_attestation import service_network, network_owner
        network_name = source_identity["network_name"]
        network_id = service_network(actual, project, network_name=network_name, hostname="fullmag-" + root.name)
        if inputs is not None and service_network(front, project, network_name=network_name) != network_id:
            raise ValueError("Frontend and backend are attached to different networks")
        network_owner(json.loads(docker("network", "inspect", network_id))[0], project, network_id, network_name=network_name)
        receipt["network_id"] = network_id
        receipt["network_name"] = network_name
        host = actual["HostConfig"]
        if actual["Image"] != image or (host.get("PortBindings") or {}) != bindings:
            raise ValueError("Runtime image or loopback port attestation mismatch")
        if backend_start is not None:
            backend_cache = backend_start.get("backend_cache")
            backend_cache_kind, _cache_adapter = _backend_cache_kind(backend_cache)
            expected_readonly = {
                "/opt/fullmag/source": Path(backend_start["source_root"]).resolve(),
                "/opt/fullmag/source-git": Path(backend_start["git_common_dir"]).resolve(),
            }
            if backend_cache_kind == "v2":
                _validate_backend_volume_cache(
                    backend_cache, expected_package=backend_start["package_root"]
                )
                from docker_backend_volume_cache import validate_container as validate_backend_cache
                receipt["backend_cache_attestation"] = validate_backend_cache(actual, backend_cache)
                # The v2 adapter owns both named-volume destinations.  Only
                # the provenance handoff remains in the generic bind check.
                expected_readwrite = {
                    "/opt/fullmag/provenance.json": Path(backend_start["provenance_path"]).resolve(),
                }
            else:
                expected_readwrite = {
                    # v1 keeps its daemon bind path contract.  Do not apply
                    # this host-path interpretation to the v2 named volumes.
                    "/opt/fullmag/package": _daemon_mount_path(
                        backend_start["package_root"], "Backend package root"
                    ),
                    "/opt/fullmag/provenance.json": Path(backend_start["provenance_path"]).resolve(),
                }
        elif inputs is not None:
            expected_readonly = {"/opt/fullmag/source": Path(inputs["source_root"]).resolve()}
            expected_readwrite = {
                "/opt/fullmag/package": package.resolve(),
                "/opt/fullmag/provenance.json": assembly_receipt.resolve(),
            }
        elif startup is not None:
            expected_readonly = {"/opt/fullmag/source": Path(startup["authorization"]["source_root"]).resolve()}
            expected_readwrite = {}
        else:
            expected_readonly = {}
            expected_readwrite = {}
        if inputs is not None or backend_start is not None or startup is not None:
            for destination, source in expected_readonly.items():
                bound = [m for m in actual["Mounts"] if m["Destination"] == destination]
                if (len(bound) != 1 or bound[0]["Type"] != "bind" or bound[0]["RW"]
                        or host_path(bound[0]["Source"]) != source):
                    raise ValueError("Development readonly bind differs: " + destination)
            for destination, source in expected_readwrite.items():
                bound = [m for m in actual["Mounts"] if m["Destination"] == destination]
                if len(bound) != 1 or bound[0]["Type"] != "bind" or not bound[0]["RW"]:
                    raise ValueError("Development writable bind differs: " + destination)
                observed_source = bound[0].get("Source")
                if destination == "/opt/fullmag/package" and backend_start is not None:
                    observed_daemon_source = _daemon_mount_path(
                        observed_source, "Development backend package bind"
                    )
                    if observed_daemon_source != source:
                        raise ValueError("Development writable bind differs: " + destination)
                elif host_path(observed_source) != source:
                    raise ValueError("Development writable bind differs: " + destination)
        if recovery is not None:
            recovery_env = dict(
                value.split("=", 1)
                for value in actual["Config"].get("Env", [])
                if "=" in value
            )
            if recovery_env.get("FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION") != \
                    "/run/fullmag/runtime-recovery-authorization.json":
                raise ValueError("Runtime recovery authorization environment was not pinned")
            recovery_mounts = [
                mount for mount in actual["Mounts"]
                if mount.get("Destination") == "/run/fullmag/runtime-recovery-authorization.json"
            ]
            if (
                len(recovery_mounts) != 1
                or recovery_mounts[0].get("Type") != "bind"
                or recovery_mounts[0].get("RW")
                or host_path(recovery_mounts[0].get("Source"))
                != Path(recovery["authorization_path"]).resolve()
            ):
                raise ValueError("Runtime recovery authorization mount is not readonly and pinned")
            receipt["runtime_recovery"].update(state="mounted_readonly")
        if startup is not None:
            startup_mounts = [m for m in actual["Mounts"]
                              if m["Destination"] == "/run/fullmag/startup-provenance.json"]
            if (len(startup_mounts) != 1 or startup_mounts[0]["Type"] != "bind"
                    or startup_mounts[0]["RW"]
                    or host_path(startup_mounts[0]["Source"]) != (metadata_root / "startup-provenance.json").resolve()):
                raise ValueError("Startup provenance must be a readonly run-owned bind")
            environment = dict(
                value.split("=", 1)
                for value in actual["Config"].get("Env", [])
                if "=" in value
            )
            expected_environment = {
                "FULLMAG_STARTUP_ENABLED": "1",
                "FULLMAG_STARTUP_SCRIPT": startup["authorization"]["container_script_path"],
                "FULLMAG_STARTUP_PROVENANCE": "/run/fullmag/startup-provenance.json",
                "FULLMAG_STARTUP_API": "http://127.0.0.1:8081",
                "FULLMAG_STARTUP_PROVENANCE_SHA256": startup["provenance_sha256"],
                "FULLMAG_STARTUP_HELPER_SHA256": startup["helper_sha256"],
            }
            if any(environment.get(key) != value for key, value in expected_environment.items()):
                raise ValueError("Startup activation environment attestation mismatch")
        mounts = [m for m in actual["Mounts"] if m["Destination"] == "/state"]
        if len(mounts) != 1 or mounts[0]["Type"] != "bind" or not mounts[0]["RW"] or host_path(mounts[0]["Source"]) != state.resolve():
            raise ValueError("Runtime state mount attestation mismatch")
        certificates = [m for m in actual["Mounts"] if m["Destination"] == "/run/fullmag/windows-folder-host.json"]
        if (len(certificates) != 1 or certificates[0]["Type"] != "bind" or certificates[0]["RW"]
                or host_path(certificates[0]["Source"]) != host_certificate.resolve()):
            raise ValueError("Readonly Windows host attestation mount mismatch")
        if not host.get("ReadonlyRootfs") or host.get("Privileged") or actual["Config"].get("User") != "65532:65532":
            raise ValueError("Runtime isolation attestation mismatch")
        if not any(d.get("Count") == -1 and ["gpu"] in d.get("Capabilities", []) for d in host.get("DeviceRequests", [])):
            raise ValueError("Runtime NVIDIA GPU request is missing")
        provenance = json.loads(docker("exec", container, "cat", "/opt/fullmag/provenance.json"))
        if backend_start is not None:
            if any(provenance.get(key) != assembly.get(key) for key in (
                    "commit", "source_digest", "native_source_identity", "source_mode",
                    "source_snapshot_sha256", "binary_hashes", "build_receipt_sha256")):
                raise ValueError("Runtime backend provenance differs from post-build receipt")
        elif any(provenance.get(key) != assembly.get(key) for key in
                 ("commit", "job_id", "source_digest", "base_image", "native_source_identity",
                  "source_mode", "source_snapshot_sha256", "live_manifest_sha256",
                  "source_git_common_dir", "binary_hashes", "startup_helper_hashes",
                  "build_receipt_sha256")):
            raise ValueError("Runtime image provenance differs from assembly receipt")
        for name, expected in helper_hashes.items():
            observed_helper = docker("exec", container, "sha256sum", "/opt/fullmag/" + name).split()[0]
            if observed_helper != expected:
                raise ValueError("Runtime image startup helper differs from assembly inventory: " + name)
        process_tree_receipt = _wait_for_startup_ready(
            state, startup["authorization"] if startup is not None else None,
            startup_helper=startup_helper if startup is not None else None,
            timeout=ready_timeout,
        )
        if recovery is not None:
            native_recovery = process_tree_receipt.get("runtime_recovery")
            if (
                not isinstance(native_recovery, dict)
                or native_recovery.get("schema_version")
                != "runtime_service_recovery.v1"
                or native_recovery.get("status") != "recovered"
                or native_recovery.get("request_id")
                != recovery["authorization"].get("request_id")
                or native_recovery.get("request_sha256")
                != recovery["authorization"].get("native_request_sha256")
            ):
                raise ValueError("Backend did not publish the pinned native recovery receipt")
            receipt["runtime_recovery"].update(
                state="recovered",
                native_receipt=native_recovery,
            )
            # The recovery overlay is a one-shot authorization.  Keep its
            # immutable file and receipt evidence, but publish the ordinary
            # Compose definition before this run can be restarted.  A stale
            # manually reintroduced overlay then still fails the native owner
            # SHA fence instead of replaying a takeover.
            normal_configured = compose_spec(
                image, state.resolve(), port, host_certificate.resolve(),
                repo=repo, inputs=inputs, inputs_path=inputs_path.resolve(),
                package=assembly.get("package_root"), provenance=assembly_receipt,
                project=project, source_identity=source_identity,
                workspace_state_root=workspace_state_root, toolchain_image=assembly.get("base_image"),
                template=compose_source_path, host_ledger=host_ledger,
                startup=startup, frontend_cache=frontend_cache,
                recovery=None, previous_config_sha256=previous_config_sha256,
            )
            normal_backend_environment = normal_configured.get("services", {}).get(
                "backend", {}
            ).get("environment", {})
            if "FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION" in normal_backend_environment:
                raise ValueError("Consumed recovery Compose definition still contains its authorization")
            consumed_path = metadata_root / "runtime-recovery-consumed.json"
            storage.atomic_json(consumed_path, {
                "schema": "fullmag.docker-runtime-recovery-consumed.v1",
                "authorization_sha256": recovery["authorization_sha256"],
                "request_sha256": recovery["request_sha256"],
                "native_after_owner_sha256": native_recovery["owner_sha256_after"],
                "previous_config_sha256": previous_config_sha256,
            })
            storage.atomic_json(spec, normal_configured)
            receipt["runtime_recovery"].update(
                state="consumed",
                consumed_authorization_sha256=recovery["authorization_sha256"],
                consumption_receipt=str(consumed_path),
                consumption_receipt_sha256=digest(consumed_path),
            )
            recovery = None
        receipt["process_tree_receipt"] = str(_startup_process_receipt_path(state))
        receipt["process_tree_receipt_sha256"] = digest(_startup_process_receipt_path(state))
        if startup is not None:
            receipt["startup_process_tree_receipt"] = str(_startup_process_receipt_path(state))
            receipt["startup_process_tree_receipt_sha256"] = receipt["process_tree_receipt_sha256"]
            receipt["startup_activation"] = process_tree_receipt["startup_activation"]
        receipt.update(state="running", health="PASS", gpu_preflight="PASS",
                       attestation="image, provenance, port, storage, GPU request, isolation")
    except Exception as error:
        receipt.update(state="failed_resources_retained", error=str(error))
        if isinstance(error, DockerOutcomeUnknown):
            receipt.update(operation_outcome="unknown", timed_out_operation=error.operation,
                           client_timeout_seconds=error.timeout_seconds)
        elif isinstance(error, StartupScriptRejected):
            receipt.update(startup_activation_outcome="rejected",
                           startup_activation=error.activation,
                           runtime_state="ready", health="PASS")
        elif isinstance(error, StartupActivationOutcomeUnknown):
            receipt.update(startup_activation_outcome="unknown",
                           startup_activation=error.diagnostic,
                           runtime_state="ready", health="PASS")
        elif isinstance(error, StartupOutcomeUnknown):
            receipt.update(startup_activation_outcome="unknown",
                           timed_out_operation=error.operation,
                           client_timeout_seconds=error.timeout_seconds)
        try:
            receipt["retained_container_ids"] = docker(*args, "ps", "--all", "--quiet").splitlines()
        except Exception as inspection_error:
            receipt["container_inspection_error"] = str(inspection_error)
        raise
    finally:
        storage.atomic_json(root / "receipt.json", receipt)
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    commands = parser.add_subparsers(dest="action", required=True)
    submit = commands.add_parser("submit")
    submit.add_argument("--commit", required=True)
    development = commands.add_parser("submit-development")
    development.add_argument("--source-root", type=Path)
    build = commands.add_parser("build-image")
    build.add_argument("--job-id", required=True)
    build.add_argument("--commit", required=True)
    build.add_argument("--development", action="store_true")
    build.add_argument("--source-root", type=Path)
    build.add_argument("--source-digest")
    build.add_argument("--native-snapshot-sha256")
    launch = commands.add_parser("start")
    launch.add_argument("--assembly-receipt", type=Path, required=True)
    launch.add_argument("--port", type=int, default=3197)
    launch.add_argument("--source-root", type=Path)
    launch.add_argument("--frontend", choices=("static", "dev"), default="static")
    launch.add_argument("--startup-script", type=Path)
    launch.add_argument("--run-receipt", type=Path,
                        help="explicit prior run receipt whose state is reused")
    launch.add_argument("--previous-config-sha256",
                        help="exact raw hash of the prior runtime service config for CAS rotation")
    launch.add_argument("--recover-idle-failure", type=Path,
                        help="explicit host authorization for one stopped failed native owner")
    args = parser.parse_args()
    if args.action == "submit":
        submit_build(args.repo_root.resolve(), args.commit)
    elif args.action == "submit-development":
        submit_build(args.repo_root.resolve(), development=True, source_root=args.source_root)
    elif args.action == "build-image":
        build_image(args.repo_root.resolve(), args.job_id, args.commit,
                    source_digest=args.source_digest, native_snapshot_sha256=args.native_snapshot_sha256, development=args.development, source_root=args.source_root)
    else:
        start(args.repo_root.resolve(), args.assembly_receipt, args.port, args.frontend,
              args.source_root, args.startup_script,
              run_receipt=args.run_receipt,
              previous_config_sha256=args.previous_config_sha256,
              recovery_authorization=args.recover_idle_failure)
