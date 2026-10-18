"""Verify one already running all-in-Docker Windows runtime.

The launcher owns image assembly, Windows-folder admission, and container
startup.  This verifier consumes that launcher's receipt and only operates on
the receipt-owned container.  It never starts, restarts, stops, removes, or
prunes a container.  The FEM smoke and FMS round-trip write only below the
owned run's ``state/verification/<id>`` directory.

The result is deliberately labelled ``runtime_smoke_not_scientific_parity``:
an executed GPU smoke is runtime evidence, not a numerical qualification.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import fullmag_storage as storage
import fullmag_docker_runtime
from run_managed_browser import SYSTEM_MOUNT_TARGETS, digest, host_path


PROFILE = "docker-all-gpu"
RUN_SCHEMA = "fullmag.docker-all-run.v1"
ASSEMBLY_SCHEMA = "fullmag.docker-all-image.v1"
VERIFICATION_SCHEMA = "fullmag.docker-all-runtime-verification.v1"
QUALIFICATION = "runtime_smoke_not_scientific_parity"
MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
MAX_HTTP_BYTES = 4 * 1024 * 1024
MAX_COMMAND_BYTES = 16 * 1024 * 1024
MAX_FMS_BYTES = 16 * 1024 * 1024
CONTAINER_ID_RE = re.compile(r"^[0-9a-f]{12,64}$")
IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
UUID_HEX_RE = re.compile(r"^[0-9a-f]{32}$")
WINDOWS_PATH_RE = re.compile(r"^[A-Za-z]:[\\/][^\x00-\x1f]*$")
STORAGE_CHECKS = (
    "file_sync",
    "directory_sync",
    "atomic_replace",
    "atomic_directory_publish",
    "process_lock",
    "no_follow_symlink",
    "no_follow_junction",
    "sqlite_transactions",
    "restart_readback",
)
# Keep the image binary admission list owned by the launcher that assembles
# and attests the image.  ``fullmag-bin`` is the current Linux writer whose
# hash the Rust Windows-folder adapter rechecks on every admission.
REQUIRED_BINARY_NAMES = fullmag_docker_runtime.REQUIRED_BINARIES

class VerificationError(RuntimeError):
    """A deterministic verifier admission or runtime failure."""


class DockerTimeout(VerificationError):
    """The Docker client timed out; the container remains untouched."""

    def __init__(self, command: Sequence[str], timeout: float):
        self.command = tuple(command)
        self.timeout = timeout
        super().__init__(
            f"Docker command timed out after {timeout:g}s; runtime resources were retained"
        )


class DockerCommandError(VerificationError):
    """A Docker client command failed without changing runtime ownership."""

    def __init__(self, command: Sequence[str], returncode: int, stderr: bytes, stdout: bytes):
        self.command = tuple(command)
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = stdout
        detail = _decode(stderr).strip() or _decode(stdout).strip() or "Docker command failed"
        super().__init__(f"Docker command failed ({returncode}): {detail[:1000]}")


@dataclass(frozen=True)
class DockerResult:
    command: tuple[str, ...]
    returncode: int
    stdout: bytes
    stderr: bytes


def _decode(value: bytes) -> str:
    return value.decode("utf-8", errors="replace")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError(f"JSON document contains duplicate key {key!r}")
        result[key] = value
    return result


def _parse_json_bytes(raw: bytes, label: str) -> Any:
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise VerificationError(f"{label} exceeds the bounded JSON read limit")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, VerificationError) as error:
        raise VerificationError(f"{label} is not valid bounded JSON: {error}") from error


def _read_bounded_regular(path: Path, label: str, *, maximum: int) -> bytes:
    """Read one evidence file through an owned descriptor.

    Native Windows uses the host adapter's handle-based no-reparse reader.  The
    Linux branch is only for bounded receipt checks and mirrors the runtime
    service's descriptor reader so pure contract tests never import WinDLL.
    """
    candidate = Path(path)
    if os.name == "nt":
        from windows_folder_host import read_owned_regular

        try:
            return read_owned_regular(candidate, maximum=maximum)
        except (OSError, ValueError) as error:
            raise VerificationError(f"{label} is not an owned regular file: {error}") from error
    if not candidate.is_absolute():
        raise VerificationError(f"{label} must be an absolute path")
    for ancestor in (candidate, *candidate.parents):
        try:
            metadata = ancestor.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise VerificationError(f"{label} cannot be inspected: {error}") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise VerificationError(f"{label} traverses a link or reparse point")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(candidate, flags)
    except OSError as error:
        raise VerificationError(f"{label} is not an owned regular file: {error}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise VerificationError(f"{label} must be an owned regular file")
        if metadata.st_size > maximum:
            raise VerificationError(f"{label} exceeds the bounded read limit")
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(descriptor, min(64 * 1024, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > maximum:
            raise VerificationError(f"{label} exceeds the bounded read limit")
        return bytes(data)
    except OSError as error:
        raise VerificationError(f"{label} could not be read: {error}") from error
    finally:
        os.close(descriptor)


def _read_json(path: Path, label: str, *, maximum: int = MAX_DOCUMENT_BYTES) -> dict[str, Any]:
    value = _parse_json_bytes(_read_bounded_regular(path, label, maximum=maximum), label)
    if not isinstance(value, dict):
        raise VerificationError(f"{label} must contain a JSON object")
    return value


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    storage.atomic_json(path, dict(value))


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.abspath(str(left))) == os.path.normcase(
        os.path.abspath(str(right))
    )


def _owned_path(value: str | os.PathLike[str], root: Path, label: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        raise VerificationError(f"{label} must be absolute")
    if storage.is_link(candidate):
        raise VerificationError(f"{label} traverses a link or reparse point")
    checked = storage.validate_path(candidate, root, label)
    if storage.is_link(checked):
        raise VerificationError(f"{label} resolves to a link or reparse point")
    return checked


def _image(value: Any, label: str = "image id") -> str:
    if not isinstance(value, str) or not IMAGE_ID_RE.fullmatch(value):
        raise VerificationError(f"{label} must be a full immutable sha256 image id")
    return value


def _container_id(value: Any) -> str:
    if not isinstance(value, str) or not CONTAINER_ID_RE.fullmatch(value):
        raise VerificationError("run receipt container_id is not a Docker container id")
    return value


def _docker_command(*args: str) -> list[str]:
    if os.name != "nt":
        raise VerificationError("all-in-Docker Windows runtime verification requires native Windows")
    return ["docker", "--context", "desktop-linux", *args]


def _docker(*args: str, timeout: float = 60.0) -> DockerResult:
    command = _docker_command(*args)
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise DockerTimeout(command, timeout) from error
    if len(result.stdout) > MAX_COMMAND_BYTES or len(result.stderr) > MAX_COMMAND_BYTES:
        raise VerificationError("Docker command output exceeded the bounded command limit")
    return DockerResult(tuple(command), result.returncode, result.stdout, result.stderr)


def _docker_checked(*args: str, timeout: float = 60.0) -> DockerResult:
    result = _docker(*args, timeout=timeout)
    if result.returncode:
        raise DockerCommandError(result.command, result.returncode, result.stderr, result.stdout)
    return result


def _docker_json(*args: str, timeout: float = 60.0) -> Any:
    result = _docker_checked(*args, timeout=timeout)
    return _parse_json_bytes(result.stdout, "Docker JSON response")


def _docker_exec(
    container: str,
    args: Sequence[str],
    *,
    timeout: float,
    log_root: Path | None = None,
    log_name: str | None = None,
    environment: Mapping[str, str] | None = None,
) -> DockerResult:
    command: list[str] = ["exec"]
    if environment:
        for key, value in environment.items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                raise VerificationError(f"unsafe Docker exec environment name: {key!r}")
            command.extend(("-e", f"{key}={value}"))
    command.extend((container, *(str(item) for item in args)))
    try:
        result = _docker(*command, timeout=timeout)
    except DockerTimeout as error:
        # subprocess.run only abandons the Docker client.  It must not issue
        # a container stop/kill, and retain a durable timeout marker beside
        # the other command logs before propagating the unknown outcome.
        if log_root is not None and log_name is not None:
            if not re.fullmatch(r"[A-Za-z0-9._-]+", log_name):
                raise VerificationError("unsafe verifier log name")
            log_root.joinpath(log_name + ".stdout.log").write_bytes(b"")
            log_root.joinpath(log_name + ".stderr.log").write_text(
                str(error) + "\n", encoding="utf-8"
            )
        raise
    if log_root is not None and log_name is not None:
        if not re.fullmatch(r"[A-Za-z0-9._-]+", log_name):
            raise VerificationError("unsafe verifier log name")
        log_root.joinpath(log_name + ".stdout.log").write_bytes(result.stdout)
        log_root.joinpath(log_name + ".stderr.log").write_bytes(result.stderr)
    if result.returncode:
        raise DockerCommandError(result.command, result.returncode, result.stderr, result.stdout)
    return result


def _http_json(port: int, path: str, *, timeout: float = 5.0) -> tuple[int, Mapping[str, str], Any]:
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_HTTP_BYTES + 1)
            headers = {key.lower(): value for key, value in response.headers.items()}
            if len(raw) > MAX_HTTP_BYTES:
                raise VerificationError(f"HTTP response for {path} exceeded the bounded limit")
            return response.status, headers, _parse_json_bytes(raw, f"HTTP response {path}")
    except urllib.error.HTTPError as error:
        raw = error.read(MAX_HTTP_BYTES + 1)
        return error.code, {key.lower(): value for key, value in error.headers.items()}, raw
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise VerificationError(f"HTTP readiness probe failed for {path}: {error}") from error


def _http_status(port: int, path: str, *, timeout: float = 5.0) -> int:
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read(MAX_HTTP_BYTES + 1)
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise VerificationError(f"HTTP readiness probe failed for {path}: {error}") from error


def _wait_http_ready(port: int, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            health_status = _http_status(port, "/healthz", timeout=2.0)
            if health_status != 200:
                raise VerificationError(f"/healthz returned HTTP {health_status}")
            status, headers, runtime = _http_json(
                port, "/v2/platform/runtime-service", timeout=3.0
            )
            if (
                status == 200
                and isinstance(runtime, dict)
                and runtime.get("schema_version") == "application_service_status.v1"
                and runtime.get("configured") is True
                and runtime.get("state") == "ready"
            ):
                return {
                    "healthz": "PASS",
                    "runtime_service": runtime,
                    "api_contract_version": headers.get("x-api-contract-version"),
                    "api_instance": headers.get("x-fullmag-api-instance"),
                }
            raise VerificationError(f"runtime-service readiness returned HTTP {status}")
        except VerificationError as error:
            last_error = error
            time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))
    raise VerificationError(f"API readiness timed out: {last_error}")


def _wait_backend_ready(container: str, timeout: float, log_root: Path) -> dict[str, Any]:
    """Check the unpublished backend API from inside its owned container."""
    probe = (
        "import json,urllib.request; "
        "response=urllib.request.urlopen("
        "'http://127.0.0.1:8081/healthz', timeout=3); "
        "response.read(4097); "
        "print(json.dumps({'status':response.status}, sort_keys=True))"
    )
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            result = _docker_exec(
                container,
                ("/usr/local/bin/python3", "-c", probe),
                timeout=10.0,
                log_root=log_root,
                log_name="backend-health",
            )
            value = _parse_json_bytes(result.stdout, "backend internal health probe")
            if isinstance(value, dict) and value.get("status") == 200:
                return {"status": "PASS", "endpoint": "http://127.0.0.1:8081/healthz"}
            last_error = VerificationError("backend internal health probe returned a non-200 status")
        except DockerTimeout:
            raise
        except VerificationError as error:
            last_error = error
        time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))
    raise VerificationError(f"backend API readiness timed out: {last_error}")


def _wait_public_openapi(port: int, timeout: float) -> dict[str, Any]:
    """Wait for the public frontend proxy to expose the canonical OpenAPI route."""
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            status, headers, document = _http_json(
                port, "/v2/platform/openapi.json", timeout=3.0
            )
            if status == 200 and isinstance(document, dict):
                return {
                    "status": "PASS",
                    "endpoint": f"http://127.0.0.1:{port}/v2/platform/openapi.json",
                    "api_contract_version": headers.get("x-api-contract-version"),
                }
            last_error = VerificationError(
                f"public frontend OpenAPI returned HTTP {status}"
            )
        except VerificationError as error:
            last_error = error
        time.sleep(min(0.25, max(0.0, deadline - time.monotonic())))
    raise VerificationError(f"public frontend OpenAPI readiness timed out: {last_error}")


def _validate_rust_accepted_store(
    container: str, port: int, source_commit: str, log_root: Path
) -> dict[str, Any]:
    """Ask the image's Rust CLI to re-admit the already bootstrapped store.

    The verifier does not duplicate the compiled session adapter's grant,
    namespace, or current-executable checks.  Requiring ``created == false``
    also makes this an observation of the runtime-service store, never a
    bootstrap fallback.
    """

    _docker_exec(
        container,
        ("test", "-d", "/state/runs/docker-all/session-store"),
        timeout=30.0,
        log_root=log_root,
        log_name="accepted-store-presence",
    )
    result = _docker_exec(
        container,
        (
            "/opt/fullmag/package/bin/fullmag-bin",
            "runtime",
            "initialize-docker-accepted-store",
        ),
        timeout=120.0,
        log_root=log_root,
        log_name="accepted-store-rust-admission",
    )
    bootstrap = _parse_json_bytes(result.stdout, "Rust accepted-store admission")
    if not isinstance(bootstrap, dict):
        raise VerificationError("Rust accepted-store admission must return an object")
    if (
        bootstrap.get("schema") != "fullmag.docker-accepted-store-bootstrap.v1"
        or bootstrap.get("store_root") != "/state/runs/docker-all/session-store"
        or bootstrap.get("created") is not False
    ):
        raise VerificationError("Rust accepted-store admission did not observe the existing store")
    binding = bootstrap.get("binding")
    if not isinstance(binding, str) or not re.fullmatch(r"[0-9a-f]{64}", binding):
        raise VerificationError("Rust accepted-store admission returned an invalid binding")
    status, headers, document = _http_json(port, "/v2/platform/openapi.json", timeout=5.0)
    if status != 200 or not isinstance(document, dict):
        raise VerificationError("Fullmag OpenAPI identity is unavailable")
    build_identity = document.get("x-fullmag-build-identity")
    store_binding = document.get("x-fullmag-runtime-store-binding")
    if (
        not isinstance(build_identity, dict)
        or build_identity.get("git_commit") != source_commit
        or not isinstance(store_binding, dict)
        or store_binding.get("schema_version") != "runtime_store_binding.v1"
        or store_binding.get("kind") != "accepted_runs"
        or store_binding.get("binding") != binding
    ):
        raise VerificationError("Rust accepted-store binding differs from the API OpenAPI identity")
    return {
        "status": "PASS",
        "store_root": bootstrap["store_root"],
        "binding": binding,
        "created": False,
        "openapi_endpoint": f"http://127.0.0.1:{port}/v2/platform/openapi.json",
        "api_contract_version": next(
            (value for key, value in headers.items() if key.lower() == "x-api-contract-version"),
            None,
        ),
    }


def _preflight_layout(layout: Mapping[str, Any]) -> None:
    """Check resolved storage without creating or repairing anything."""

    storage.validate_managed_view(dict(layout))
    storage_root = Path(layout["storage_root"])
    build_root = Path(layout["build_storage_root"])
    if not storage_root.is_dir() or storage.is_link(storage_root):
        raise VerificationError("resolved project storage root is not an owned directory")
    if not build_root.is_dir() or storage.is_link(build_root):
        raise VerificationError("resolved build storage root is not an owned directory")
    for field in ("runs_root", "runtime_root", "build_root"):
        value = Path(layout[field])
        storage.validate_path(value, storage_root if field == "runs_root" else build_root, field)
        if storage.is_link(value):
            raise VerificationError(f"resolved {field} traverses a link or reparse point")


def _validate_run_bundle(repo: Path, receipt_argument: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], Path, Path, Path]:
    layout = storage.resolve_layout(repo, PROFILE)
    _preflight_layout(layout)
    storage_root = Path(layout["storage_root"])
    runs_root = Path(layout["runs_root"])
    expected_parent = storage.validate_path(runs_root / "docker-all", runs_root, "Docker run root")
    receipt_path = _owned_path(receipt_argument, expected_parent, "Docker run receipt")
    run_root = receipt_path.parent
    if not _same_path(run_root.parent, expected_parent) or not UUID_HEX_RE.fullmatch(run_root.name):
        raise VerificationError("Docker run receipt is outside its owned UUID run root")
    receipt = _read_json(receipt_path, "Docker run receipt")
    if (
        receipt.get("schema") != RUN_SCHEMA
        or receipt.get("state") != "running"
        or receipt.get("health") != "PASS"
        or receipt.get("qualification") != "NOT VERIFIED"
    ):
        raise VerificationError("Docker run receipt is not a successful running receipt")
    image = _image(receipt.get("image_id"), "run receipt image_id")
    container = _container_id(receipt.get("container_id"))
    state_value = receipt.get("state_root")
    if not isinstance(state_value, str):
        raise VerificationError("run receipt state_root is missing")
    state = _owned_path(state_value, run_root, "Docker state root")
    if not state.is_dir() or not _same_path(state, run_root / "state"):
        raise VerificationError("run receipt state_root differs from the owned state directory")
    assembly_value = receipt.get("assembly_receipt")
    if not isinstance(assembly_value, str):
        raise VerificationError("run receipt assembly_receipt is missing")
    assembly_path = _owned_path(
        assembly_value, Path(layout["build_storage_root"]), "Docker assembly receipt"
    )
    assembly = _read_json(assembly_path, "Docker assembly receipt")
    if (
        assembly.get("schema") != ASSEMBLY_SCHEMA
        or assembly.get("state") != "succeeded"
        or assembly.get("exit_code") != 0
    ):
        raise VerificationError("Docker assembly receipt is not terminal and successful")
    if _image(assembly.get("image_id"), "assembly image_id") != image:
        raise VerificationError("run and assembly image identities differ")
    assembly_digest = receipt.get("assembly_receipt_sha256")
    if not isinstance(assembly_digest, str) or digest(assembly_path) != assembly_digest:
        raise VerificationError("run receipt assembly receipt digest differs from disk")
    commit = assembly.get("commit")
    if not isinstance(commit, str) or not COMMIT_RE.fullmatch(commit):
        raise VerificationError("assembly receipt source commit is invalid")
    native = assembly.get("native_source_identity")
    if not isinstance(native, dict) or native.get("head_commit_full") != commit:
        raise VerificationError("assembly source identity does not pin the source commit")
    if receipt.get("native_source_identity") != native:
        raise VerificationError("run receipt source identity differs from assembly")
    binary_hashes = assembly.get("binary_hashes")
    if not isinstance(binary_hashes, dict) or not binary_hashes:
        raise VerificationError("assembly receipt has no binary provenance")
    if any(
        name not in binary_hashes
        or not isinstance(binary_hashes[name], str)
        or not re.fullmatch(r"[0-9a-f]{64}", binary_hashes[name])
        for name in REQUIRED_BINARY_NAMES
    ):
        raise VerificationError("assembly receipt lacks an attested hash for a required runtime binary")
    checks = receipt.get("storage_operational_checks")
    if not isinstance(checks, dict) or set(checks) != set(STORAGE_CHECKS) or not all(
        checks.get(name) is True for name in STORAGE_CHECKS
    ):
        raise VerificationError("run receipt lacks the complete Windows storage check set")
    if receipt.get("storage_power_loss") != "NOT VERIFIED":
        raise VerificationError("run receipt power-loss qualification changed unexpectedly")
    return receipt, assembly, layout, run_root, state, assembly_path


def _validate_storage_attestation(
    receipt: Mapping[str, Any],
    assembly: Mapping[str, Any],
    run_root: Path,
    state: Path,
) -> dict[str, Any]:
    """Check host-side evidence and the launch pins.

    The complete grant and current-writer admission are owned by the Rust
    command invoked later by ``_validate_rust_accepted_store`` and by the real
    session commands.  This function only correlates their bounded evidence
    with the launcher receipt and native Windows readback.
    """
    from windows_folder_host import local_volume, read_owned_regular

    host_path = run_root / "windows-folder-host.json"
    host_bytes = read_owned_regular(host_path)
    host = _parse_json_bytes(host_bytes, "native Windows host attestation")
    if not isinstance(host, dict):
        raise VerificationError("Windows host attestation must contain an object")
    if (
        host.get("schema") != "fullmag.windows-folder-host.v1"
        or host.get("storage_profile") != "windows-folder-v1"
        or host.get("role") != "session"
        or host.get("owner_scope") != "docker-desktop-linux"
    ):
        raise VerificationError("Windows host attestation scope is invalid")
    if not isinstance(host.get("host_root"), str) or not WINDOWS_PATH_RE.fullmatch(host["host_root"]):
        raise VerificationError("Windows host attestation root is not a local drive path")
    if not _same_path(Path(host["host_root"]), state):
        raise VerificationError("Windows host attestation root differs from the run state")
    owner_token = host.get("owner_token")
    if not isinstance(owner_token, str):
        raise VerificationError("Windows host owner token is missing")
    if host.get("image_id") != assembly.get("image_id") or host.get("source_commit") != assembly.get("commit"):
        raise VerificationError("Windows host attestation image/source differs from provenance")
    if host.get("binary_hashes") != assembly.get("binary_hashes"):
        raise VerificationError("Windows host binary hashes differ from assembly provenance")
    if host.get("artifact_receipt_sha256") != assembly.get("build_receipt_sha256"):
        raise VerificationError("Windows host artifact receipt pin differs from assembly")
    if host.get("restart_verified") is not True:
        raise VerificationError("Native Windows restart readback is not verified")
    marker_path = state / ".fullmag-windows-folder-owner.json"
    marker_bytes = read_owned_regular(marker_path)
    marker = _parse_json_bytes(marker_bytes, "Windows session owner marker")
    if marker != host:
        raise VerificationError("Windows session owner marker differs from host attestation")
    expected_checks = receipt.get("storage_operational_checks")
    if not isinstance(expected_checks, dict):
        raise VerificationError("run receipt storage checks are unavailable")
    volume = local_volume(state)
    expected_volume = {
        key: host[key]
        for key in ("host_root", "host_filesystem", "host_drive_type", "host_volume_serial", "host_root_no_reparse")
    }
    if volume != expected_volume:
        raise VerificationError("Native Windows volume identity changed after launch")
    probe = _parse_json_bytes(
        read_owned_regular(state / ".windows-folder-probe/probe-restart.json"),
        "Windows restart probe",
    )
    if not isinstance(probe, dict) or probe.get("checks") != expected_checks:
        raise VerificationError("Windows guest restart probe differs from the launch receipt")
    sentinel = read_owned_regular(state / ".windows-folder-probe/restart-sentinel.bin")
    if hashlib.sha256(sentinel).hexdigest() != host.get("restart_expected_sha256"):
        raise VerificationError("Native Windows restart sentinel does not match host evidence")
    return {
        "host_certificate_sha256": hashlib.sha256(host_bytes).hexdigest(),
        "owner_token": owner_token,
        "filesystem": host["host_filesystem"],
        "volume_serial": host["host_volume_serial"],
        "restart_readback": "PASS",
        "checks": expected_checks,
        "power_loss": "NOT VERIFIED",
    }


def _validate_host_ledger_attestation(
    receipt: Mapping[str, Any],
    document: Mapping[str, Any],
    run_root: Path,
    docker_callable=None,
) -> dict[str, Any]:
    """Re-attest the persistent host-ledger binding recorded by the launcher.

    The launcher already ran the privileged maintenance ``ensure`` and stored
    its immutable adapter receipt.  Runtime verification must correlate that
    receipt with the running backend and use the adapter's canonical validator,
    but must not run the maintenance Compose service again.  Removing only
    ``maintenance_compose`` from the validator input leaves its guest-side
    probe and all bind/isolation checks active while forcing it to use the
    recorded host receipt.
    """
    import docker_host_ledger as host_ledger

    profile = receipt.get("host_ledger")
    attestation = receipt.get("host_ledger_attestation")
    if not isinstance(profile, Mapping):
        raise VerificationError("run receipt lacks the host-ledger adapter receipt")
    if not isinstance(attestation, Mapping):
        raise VerificationError("run receipt lacks the host-ledger container attestation")
    if profile.get("schema") != host_ledger.SCHEMA or profile.get("profile") != host_ledger.PROFILE:
        raise VerificationError("host-ledger adapter schema/profile is unsupported")
    if profile.get("state") != "ready":
        raise VerificationError("host-ledger adapter receipt is not ready")
    image = _image(receipt.get("image_id"), "run receipt image_id")
    if profile.get("image_id") != image:
        raise VerificationError("host-ledger adapter image differs from the runtime image")
    required_profile_fields = (
        "run_root", "run_id", "project_id", "mount_root", "ledger_root",
        "ledger_root_daemon", "backing_image", "receipt", "receipt_sha256",
        "host_receipt", "environment",
    )
    if any(profile.get(key) in (None, "") for key in required_profile_fields):
        raise VerificationError("host-ledger adapter profile is incomplete")
    if not _same_path(Path(profile["run_root"]), run_root):
        raise VerificationError("host-ledger adapter run root differs from the owned run root")

    environment = profile.get("environment")
    if not isinstance(environment, Mapping):
        raise VerificationError("host-ledger adapter environment is missing")
    fixed_environment = {
        "FULLMAG_HOST_LEDGER_PROFILE": host_ledger.PROFILE,
        "FULLMAG_HOST_LEDGER_ROOT": host_ledger.LEDGER_ROOT,
        "FULLMAG_HOST_LEDGER_MOUNT_TARGET": host_ledger.MOUNT_TARGET,
        "FULLMAG_HOST_LEDGER_MOUNT_ROOT": profile.get("mount_root"),
        "FULLMAG_HOST_LEDGER_LEDGER_ROOT": profile.get("ledger_root_daemon"),
        "FULLMAG_HOST_LEDGER_BACKING_IMAGE": profile.get("backing_image"),
        "FULLMAG_HOST_LEDGER_PROJECT_ID": profile.get("project_id"),
    }
    if any(not isinstance(value, str) or not value for value in fixed_environment.values()):
        raise VerificationError("host-ledger adapter profile has incomplete fixed paths")
    if any(environment.get(key) != value for key, value in fixed_environment.items()):
        raise VerificationError("host-ledger adapter environment differs from its resolved profile")

    adapter_value = profile.get("receipt")
    if not isinstance(adapter_value, str):
        raise VerificationError("host-ledger adapter receipt path is missing")
    adapter_path = _owned_path(adapter_value, run_root, "host-ledger adapter receipt")
    adapter = _read_json(adapter_path, "host-ledger adapter receipt")
    if (
        adapter.get("schema") != host_ledger.RECEIPT_SCHEMA
        or adapter.get("profile") != host_ledger.PROFILE
        or adapter.get("state") != "ready"
    ):
        raise VerificationError("host-ledger adapter receipt is not a ready v1 receipt")
    if profile.get("receipt_sha256") != digest(adapter_path):
        raise VerificationError("host-ledger adapter receipt digest differs from the launcher profile")
    if adapter.get("receipt_path") != str(adapter_path):
        raise VerificationError("host-ledger adapter receipt path differs from its frozen path")
    for key in ("run_id", "project_id", "image_id", "backing_image", "mount_root", "ledger_root"):
        if adapter.get(key) != profile.get(key):
            raise VerificationError(f"host-ledger adapter receipt differs at {key}")
    if adapter.get("environment") != environment:
        raise VerificationError("host-ledger adapter receipt environment differs from the launcher profile")
    ensure_host_receipt = profile.get("host_receipt")
    if not isinstance(ensure_host_receipt, Mapping) or adapter.get("host_receipt") != ensure_host_receipt:
        raise VerificationError("host-ledger maintenance receipt is missing or differs from the adapter receipt")
    required_host_receipt_fields = (
        "schema", "profile", "state", "project_id", "backing_image", "mount_root",
        "mount_target", "ledger_root", "filesystem", "filesystem_uuid",
        "image_size_bytes", "loop_device", "mount_active",
    )
    if any(ensure_host_receipt.get(key) in (None, "") for key in required_host_receipt_fields):
        raise VerificationError("host-ledger maintenance receipt is incomplete")
    if (
        ensure_host_receipt.get("schema") != host_ledger.HOST_RECEIPT_SCHEMA
        or ensure_host_receipt.get("profile") != host_ledger.PROFILE
        or ensure_host_receipt.get("state") != "ready"
        or ensure_host_receipt.get("filesystem") != "ext4"
        or ensure_host_receipt.get("mount_active") is not True
        or ensure_host_receipt.get("mount_target") != host_ledger.MOUNT_TARGET
        or ensure_host_receipt.get("image_size_bytes") != host_ledger.IMAGE_SIZE_BYTES
        or ensure_host_receipt.get("project_id") != profile.get("project_id")
        or ensure_host_receipt.get("mount_root") != profile.get("mount_root")
        or ensure_host_receipt.get("ledger_root") != profile.get("mount_root") + "/ledger"
        or ensure_host_receipt.get("backing_image") != profile.get("backing_image")
    ):
        raise VerificationError("host-ledger ensure receipt identity is invalid")

    verify_host_receipt = attestation.get("host_receipt")
    if not isinstance(verify_host_receipt, Mapping):
        raise VerificationError("host-ledger container attestation lacks its verify receipt")
    if any(verify_host_receipt.get(key) in (None, "") for key in required_host_receipt_fields):
        raise VerificationError("host-ledger verify receipt is incomplete")
    stable_host_receipt_fields = (
        "schema", "profile", "project_id", "backing_image", "mount_root", "mount_target",
        "ledger_root", "filesystem", "filesystem_uuid", "image_size_bytes", "loop_device",
        "mount_active",
    )
    if any(verify_host_receipt.get(key) != ensure_host_receipt.get(key) for key in stable_host_receipt_fields):
        raise VerificationError("host-ledger verify receipt identity differs from ensure")
    if (
        verify_host_receipt.get("schema") != host_ledger.HOST_RECEIPT_SCHEMA
        or verify_host_receipt.get("profile") != host_ledger.PROFILE
        or verify_host_receipt.get("state") != "validated"
        or verify_host_receipt.get("filesystem") != "ext4"
        or verify_host_receipt.get("mount_active") is not True
        or verify_host_receipt.get("created_image") is not False
    ):
        raise VerificationError("host-ledger verify receipt does not describe a validated verify action")

    expected_attestation = {
        "schema": "fullmag.docker-host-ledger-attestation.v1",
        "profile": host_ledger.PROFILE,
        "backend_container_id": _container_id(receipt.get("container_id")),
        "mount_target": host_ledger.MOUNT_TARGET,
        "ledger_root": host_ledger.LEDGER_ROOT,
        "filesystem": "ext4",
        "filesystem_uuid": verify_host_receipt.get("filesystem_uuid"),
        "loop_device": verify_host_receipt.get("loop_device"),
        "backing_image": verify_host_receipt.get("backing_image"),
        "backend_verification": "PASS",
        "host_verification": "PASS",
        "host_receipt": verify_host_receipt,
    }
    if any(attestation.get(key) != value for key, value in expected_attestation.items()):
        raise VerificationError("host-ledger container attestation differs from the launcher evidence")

    validation_profile = dict(profile)
    validation_profile.pop("maintenance_compose", None)
    validation_profile["host_receipt"] = dict(verify_host_receipt)
    if docker_callable is None:
        def docker_callable(*args, timeout=60, **_kwargs):
            return _decode(_docker_checked(*args, timeout=timeout).stdout)
    try:
        validated = host_ledger.validate_container(document, validation_profile, docker_callable)
    except Exception as error:
        raise VerificationError(f"host-ledger live container validation failed: {error}") from error
    if validated != dict(attestation):
        raise VerificationError("host-ledger canonical validation differs from launcher attestation")
    return dict(validated)


def _runtime_topology(receipt: Mapping[str, Any]) -> tuple[str, int, str | None]:
    mode = receipt.get("frontend_mode")
    if mode not in {"static", "dev"}:
        raise VerificationError("run receipt frontend_mode must be static or dev")
    expected_container_port = 8080 if mode == "dev" else 8081
    if receipt.get("container_http_port") != expected_container_port:
        raise VerificationError("run receipt container_http_port differs from frontend mode")
    parsed_url = urllib.parse.urlparse(str(receipt.get("url", "")))
    if parsed_url.port is None:
        raise VerificationError("run receipt URL has no forwarded port")
    frontend_value = receipt.get("frontend_container_id")
    if mode == "dev":
        if not isinstance(frontend_value, str):
            raise VerificationError("dev runtime receipt lacks frontend_container_id")
        frontend_id = _container_id(frontend_value)
        backend_id = receipt.get("container_id")
        if isinstance(backend_id, str) and (
            frontend_id.startswith(backend_id) or backend_id.startswith(frontend_id)
        ):
            raise VerificationError("backend and frontend container identities must differ")
    else:
        if frontend_value is not None:
            raise VerificationError("static runtime receipt must not name a frontend container")
        frontend_id = None
    return mode, parsed_url.port, frontend_id


def _inspect_container(container_id: str, label: str) -> dict[str, Any]:
    documents = _docker_json("inspect", container_id)
    if not isinstance(documents, list) or len(documents) != 1:
        raise VerificationError(f"Docker {label} inspect did not return one container")
    document = documents[0]
    observed_id = document.get("Id")
    if not isinstance(observed_id, str) or not observed_id.startswith(container_id):
        raise VerificationError(f"Docker {label} identity differs from the run receipt")
    return document


def _environment(config: Mapping[str, Any]) -> dict[str, str]:
    return {
        item.split("=", 1)[0]: item.split("=", 1)[1]
        for item in config.get("Env", [])
        if isinstance(item, str) and "=" in item
    }


def _validate_isolation(document: Mapping[str, Any], label: str, *, gpu: bool) -> None:
    host_config = document.get("HostConfig") or {}
    config = document.get("Config") or {}
    if (
        config.get("User") != "65532:65532"
        or host_config.get("ReadonlyRootfs") is not True
        or host_config.get("Privileged") is True
        or set(host_config.get("CapDrop") or []) != {"ALL"}
        or "no-new-privileges:true" not in (host_config.get("SecurityOpt") or [])
    ):
        raise VerificationError(f"Docker {label} isolation differs from the attested compose spec")
    requests = host_config.get("DeviceRequests") or []
    if gpu:
        if not any(
            request.get("Count") == -1
            and any("gpu" in capabilities for capabilities in request.get("Capabilities", []))
            for request in requests
        ):
            raise VerificationError(f"Docker {label} NVIDIA GPU request is missing")
    elif requests:
        raise VerificationError(f"Docker {label} unexpectedly requests GPU devices")


def _validate_frontend_inputs(
    receipt: Mapping[str, Any],
    run_root: Path,
    mounts: Sequence[Mapping[str, Any]],
    public_port: int,
) -> dict[str, Any]:
    inputs_value = receipt.get("frontend_inputs")
    if not isinstance(inputs_value, str):
        raise VerificationError("dev runtime receipt lacks frontend_inputs")
    inputs_path = _owned_path(inputs_value, run_root, "frontend development inputs")
    inputs_digest = receipt.get("frontend_inputs_sha256")
    if not isinstance(inputs_digest, str) or not re.fullmatch(r"[0-9a-f]{64}", inputs_digest):
        raise VerificationError("dev runtime receipt frontend input digest is invalid")
    inputs_bytes = _read_bounded_regular(
        inputs_path, "frontend development inputs", maximum=MAX_DOCUMENT_BYTES
    )
    if hashlib.sha256(inputs_bytes).hexdigest() != inputs_digest:
        raise VerificationError("frontend development inputs digest differs from the receipt")
    inputs = _parse_json_bytes(inputs_bytes, "frontend development inputs")
    if not isinstance(inputs, dict) or inputs.get("schema") != "fullmag.docker-development-inputs.v1":
        raise VerificationError("frontend development inputs schema is invalid")
    if (
        inputs.get("source_root") != receipt.get("frontend_source_root")
        or inputs.get("source_commit") != receipt.get("frontend_source_commit")
        or not isinstance(inputs.get("source_commit"), str)
        or not COMMIT_RE.fullmatch(inputs["source_commit"])
        or inputs.get("host_port") != public_port
        or inputs.get("workspace_root") != "/state/development/workspace"
        or inputs.get("frontend_root") != "/state/development/cache"
    ):
        raise VerificationError("frontend source or public port identity differs from the run receipt")
    live_directories = inputs.get("live_directories")
    if not isinstance(live_directories, list) or not all(
        isinstance(entry, dict)
        and isinstance(entry.get("target"), str)
        and isinstance(entry.get("source"), str)
        for entry in live_directories
    ):
        raise VerificationError("frontend development inputs have malformed live directories")
    expected_inputs_mounts = {
        "/run/fullmag/development-inputs.json": str(inputs_path),
        **{entry["target"]: entry["source"] for entry in live_directories},
    }
    if len(expected_inputs_mounts) != 1 + len(live_directories):
        raise VerificationError("frontend development inputs have malformed live directories")
    actual_bind_targets = {
        mount.get("Destination")
        for mount in mounts
        if mount.get("Type") == "bind"
    }
    expected_bind_targets = {"/state/development", *expected_inputs_mounts}
    unexpected_bind_targets = actual_bind_targets - expected_bind_targets - SYSTEM_MOUNT_TARGETS
    if unexpected_bind_targets:
        raise VerificationError("frontend bind mounts differ from the development input manifest")
    from docker_development_inputs import attest_mounts

    frontend_document = {"Mounts": list(mounts)}
    attest_mounts(frontend_document, inputs, inputs_path)
    return {
        "source_root": inputs["source_root"],
        "source_commit": inputs["source_commit"],
        "inputs": str(inputs_path),
        "inputs_sha256": inputs_digest,
        "live_mounts": sorted(expected_bind_targets),
    }


def _validate_frontend_dev_container(
    receipt: Mapping[str, Any],
    run_root: Path,
    state: Path,
    image: str,
    public_port: int,
    frontend_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    document = _inspect_container(frontend_id, "frontend container")
    if document.get("Image") != image or document.get("State", {}).get("Running") is not True:
        raise VerificationError("receipt-owned frontend is not running the pinned image")
    labels = document.get("Config", {}).get("Labels") or {}
    if (
        labels.get("com.docker.compose.project") != receipt.get("compose_project")
        or labels.get("com.docker.compose.service") != "frontend"
    ):
        raise VerificationError("Docker frontend compose ownership labels differ from the run receipt")
    _validate_isolation(document, "frontend", gpu=False)
    host_config = document.get("HostConfig") or {}
    expected_bindings = {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(public_port)}]}
    if host_config.get("PortBindings") != expected_bindings:
        raise VerificationError("Docker frontend loopback port binding differs from the receipt")
    mounts = document.get("Mounts") or []
    if any(mount.get("Type") == "volume" for mount in mounts):
        raise VerificationError("Docker frontend unexpectedly uses a named volume")
    writable_binds = [
        mount for mount in mounts if mount.get("Type") == "bind" and mount.get("RW") is True
    ]
    development_state = state / "development"
    if (
        len(writable_binds) != 1
        or writable_binds[0].get("Destination") != "/state/development"
        or not _same_path(host_path(writable_binds[0].get("Source", "")), development_state)
    ):
        raise VerificationError("frontend writable mount must be its isolated development directory")
    if any(
        mount.get("Destination") in {"/state", "/run/fullmag/windows-folder-host.json"}
        for mount in mounts
    ):
        raise VerificationError("frontend must not receive backend state or host certificate mounts")
    if any(
        mount.get("Type") == "bind"
        and mount.get("Destination") != "/state/development"
        and mount.get("RW") is not False
        for mount in mounts
    ):
        raise VerificationError("frontend non-state bind mounts must be read-only")
    environment = _environment(document.get("Config") or {})
    if (
        environment.get("FULLMAG_DOCKER_ROLE") != "frontend"
        or environment.get("FULLMAG_DOCKER_FRONTEND") != "dev"
        or environment.get("FULLMAG_API_PROXY_TARGET") != "http://backend:8081"
        or environment.get("HOME") != "/state/development"
    ):
        raise VerificationError("frontend development proxy environment differs from the receipt")
    inputs = _validate_frontend_inputs(receipt, run_root, mounts, public_port)
    return document, {
        "container_id": frontend_id,
        "port": public_port,
        "gpu_request": "NONE",
        "isolation": "PASS",
        "inputs": inputs,
    }


def _validate_development_backend_mounts(document, receipt, assembly):
    """Keep live source identity separate from the immutable compiled package."""
    if assembly.get("runtime_mode") != "development_source_bind":
        raise VerificationError("dev runtime does not use a source-bind image")
    values = {
        "/opt/fullmag/source": receipt.get("source_root"),
        "/opt/fullmag/package": assembly.get("package_root"),
        "/opt/fullmag/provenance.json": receipt.get("assembly_receipt"),
    }
    mounts = document.get("Mounts") or []
    for target, source in values.items():
        if not isinstance(source, str) or not source:
            raise VerificationError("dev runtime lacks readonly bind provenance: " + target)
        matches = [mount for mount in mounts if mount.get("Destination") == target]
        if (len(matches) != 1 or matches[0].get("Type") != "bind"
                or matches[0].get("RW") is not False
                or not _same_path(host_path(matches[0].get("Source", "")), host_path(source))):
            raise VerificationError("dev runtime readonly bind differs: " + target)
    if receipt.get("compiled_source_commit") != assembly.get("commit"):
        raise VerificationError("dev runtime compiled source identity differs from package")


def _validate_container(
    receipt: Mapping[str, Any],
    assembly: Mapping[str, Any],
    run_root: Path,
    state: Path,
    log_root: Path | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    mode, public_port, frontend_id = _runtime_topology(receipt)
    image = _image(receipt["image_id"])
    container_id = _container_id(receipt["container_id"])
    image_documents = _docker_json("image", "inspect", image)
    if not isinstance(image_documents, list) or len(image_documents) != 1:
        raise VerificationError("Docker image inspect did not return one image")
    image_document = image_documents[0]
    if image_document.get("Id") != image or image_document.get("Config", {}).get("Volumes"):
        raise VerificationError("Docker image identity or anonymous volumes are invalid")
    labels = image_document.get("Config", {}).get("Labels") or {}
    if labels.get("org.fullmag.runtime") != "docker-all-gpu-v1":
        raise VerificationError("Docker image is not the pinned Fullmag GPU runtime")
    document = _inspect_container(container_id, "backend container")
    if document.get("Image") != image or document.get("State", {}).get("Running") is not True:
        raise VerificationError("receipt-owned Docker backend is not running the pinned image")
    container_labels = document.get("Config", {}).get("Labels") or {}
    if (
        container_labels.get("com.docker.compose.project") != receipt.get("compose_project")
        or container_labels.get("com.docker.compose.service") != "backend"
    ):
        raise VerificationError("Docker backend compose ownership labels differ from the run receipt")
    if mode == "dev":
        if labels.get("org.fullmag.development") != "source-bind-v1":
            raise VerificationError("dev image does not declare source-bind development")
        _validate_development_backend_mounts(document, receipt, assembly)
    from docker_compose_attestation import service_network, network_owner
    network_id = service_network(document, receipt["compose_project"], hostname="fullmag-" + run_root.name)
    if receipt.get("network_id") != network_id:
        raise VerificationError("Backend network ID differs from the launch receipt")
    network_documents = _docker_json("network", "inspect", network_id)
    if not isinstance(network_documents, list) or len(network_documents) != 1:
        raise VerificationError("Docker network inspect did not return one network")
    network_owner(network_documents[0], receipt["compose_project"], network_id)
    _validate_isolation(document, "backend", gpu=True)
    host_config = document.get("HostConfig") or {}
    if mode == "static":
        expected_bindings = {"8081/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(public_port)}]}
        if host_config.get("PortBindings") != expected_bindings:
            raise VerificationError("Docker backend loopback port binding differs from the receipt")
    elif (host_config.get("PortBindings") or {}):
        raise VerificationError("dev backend must not publish an API port")
    mounts = document.get("Mounts") or []
    if any(mount.get("Type") == "volume" for mount in mounts):
        raise VerificationError("Docker backend unexpectedly uses a named volume")
    state_mounts = [mount for mount in mounts if mount.get("Destination") == "/state"]
    certificate_path = run_root / "windows-folder-host.json"
    certificate_mounts = [
        mount
        for mount in mounts
        if mount.get("Destination") == "/run/fullmag/windows-folder-host.json"
    ]
    if (
        len(state_mounts) != 1
        or state_mounts[0].get("Type") != "bind"
        or state_mounts[0].get("RW") is not True
        or not _same_path(host_path(state_mounts[0].get("Source", "")), state)
        or len(certificate_mounts) != 1
        or certificate_mounts[0].get("Type") != "bind"
        or certificate_mounts[0].get("RW") is not False
        or not _same_path(host_path(certificate_mounts[0].get("Source", "")), certificate_path)
    ):
        raise VerificationError("Docker backend state/certificate bind mounts differ from attestation")
    environment = _environment(document.get("Config") or {})
    if (
        environment.get("FULLMAG_SESSION_STORAGE_PROFILE") != "windows-folder-v1"
        or environment.get("FULLMAG_RUNTIME_IMAGE_ID") != image
        or (mode == "dev" and environment.get("FULLMAG_DOCKER_ROLE") != "backend")
    ):
        raise VerificationError("Docker backend image environment pin differs from the image")
    provenance_result = _docker_exec(
        container_id,
        ("cat", "/opt/fullmag/provenance.json"),
        timeout=30.0,
        log_root=log_root,
        log_name="image-provenance",
    )
    provenance = _parse_json_bytes(provenance_result.stdout, "runtime image provenance")
    if not isinstance(provenance, dict):
        raise VerificationError("runtime image provenance must be a JSON object")
    for key in (
        "commit",
        "job_id",
        "source_digest",
        "base_image",
        "native_source_identity",
        "binary_hashes",
        "build_receipt_sha256",
    ):
        if provenance.get(key) != assembly.get(key):
            raise VerificationError(f"runtime image provenance differs at {key}")
    binary_result = _docker_exec(
        container_id,
        ("sha256sum", *(f"/opt/fullmag/package/bin/{name}" for name in REQUIRED_BINARY_NAMES)),
        timeout=60.0,
        log_root=log_root,
        log_name="image-binary-hashes",
    )
    observed_hashes: dict[str, str] = {}
    binary_lines = _decode(binary_result.stdout).splitlines()
    if len(binary_lines) != len(REQUIRED_BINARY_NAMES):
        raise VerificationError("runtime binary hash probe returned an incomplete result")
    for line in binary_lines:
        fields = line.split()
        if len(fields) != 2 or not re.fullmatch(r"[0-9a-f]{64}", fields[0]):
            raise VerificationError("runtime binary hash probe returned malformed output")
        path = fields[1].replace("\\", "/")
        prefix = "/opt/fullmag/package/bin/"
        if not path.startswith(prefix) or path[len(prefix) :] not in REQUIRED_BINARY_NAMES:
            raise VerificationError("runtime binary hash probe returned an unexpected path")
        observed_hashes[path[len(prefix) :]] = fields[0]
    if observed_hashes != {name: assembly["binary_hashes"][name] for name in REQUIRED_BINARY_NAMES}:
        raise VerificationError("runtime binary bytes differ from the attested image hashes")
    frontend_attestation = None
    if mode == "dev":
        assert frontend_id is not None
        frontend_document, frontend_attestation = _validate_frontend_dev_container(
            receipt, run_root, state, image, public_port, frontend_id
        )
        if service_network(frontend_document, receipt["compose_project"]) != network_id:
            raise VerificationError("Frontend and backend network IDs differ")
    return document, {
        "image": image_document,
        "provenance": provenance,
        "port": public_port,
        "backend_port": 8081,
        "frontend_mode": mode,
        "frontend_container_id": frontend_id,
        "frontend": frontend_attestation,
        "binary_hashes": observed_hashes,
    }

def _verification_command(
    container_root: str,
    receipt_path: str,
) -> list[str]:
    return [
        "/opt/fullmag/package/bin/fullmag-bin",
        "/opt/fullmag/source/examples/fem_relax_gpu_smoke.py",
        "--backend",
        "fem",
        "--precision",
        "double",
        "--headless",
        "--ui",
        "none",
        "--existing-output",
        "error",
        "--output-dir",
        f"{container_root}/output",
        "--workspace-root",
        f"{container_root}/workspace",
        "--receipt",
        receipt_path,
    ]


def _python_probe(container: str, log_root: Path) -> dict[str, Any]:
    probe = (
        "import json,sys,fullmag,_fullmag_core; "
        "print(json.dumps({"
        "'python_version':sys.version,"
        "'executable':sys.executable,"
        "'fullmag_module':fullmag.__file__,"
        "'fullmag_core_module':_fullmag_core.__file__"
        "}, sort_keys=True))"
    )
    result = _docker_exec(
        container,
        ("/usr/local/bin/python3", "-c", probe),
        timeout=30.0,
        log_root=log_root,
        log_name="python-dsl-probe",
    )
    value = _parse_json_bytes(result.stdout, "Python DSL probe")
    if not isinstance(value, dict) or not all(
        isinstance(value.get(key), str) and value[key]
        for key in ("python_version", "executable", "fullmag_module", "fullmag_core_module")
    ):
        raise VerificationError("Python DSL probe omitted interpreter or module identity")
    if (not str(value["fullmag_module"]).startswith("/opt/fullmag/source/packages/fullmag-py/src/fullmag/")
            or str(value["fullmag_core_module"]) != "/opt/fullmag/package/_fullmag_core.so"):
        raise VerificationError("Python DSL modules resolved outside the immutable image")
    return {"status": "PASS", **value}


def _validate_gpu_smoke_receipt(path: Path, container_root: str) -> dict[str, Any]:
    if os.name == "nt":
        from windows_folder_host import read_owned_regular

        receipt = _parse_json_bytes(read_owned_regular(path), "FEM GPU smoke receipt")
        if not isinstance(receipt, dict):
            raise VerificationError("FEM GPU smoke receipt must contain a JSON object")
    else:
        receipt = _read_json(path, "FEM GPU smoke receipt")
    if receipt.get("schema") != "fullmag.script_run_receipt.v1":
        raise VerificationError("FEM GPU smoke did not produce the managed script receipt")
    requested = receipt.get("requested")
    resolved = receipt.get("resolved")
    outcome = receipt.get("outcome")
    if not isinstance(requested, dict) or not isinstance(resolved, dict) or not isinstance(outcome, dict):
        raise VerificationError("FEM GPU smoke receipt has incomplete provenance")
    if requested.get("backend") != "fem" or requested.get("precision") != "double":
        raise VerificationError("FEM GPU smoke requested provenance is not fem/double")
    effective = resolved.get("requested_effective")
    if not isinstance(effective, dict) or effective.get("device") != "gpu":
        raise VerificationError("FEM GPU smoke requested device was not recorded as GPU")
    if (
        "fallback" not in resolved
        or resolved.get("backend") != "fem"
        or resolved.get("device") != "gpu"
        or resolved.get("precision") != "double"
        or resolved.get("fallback") is not None
    ):
        raise VerificationError("FEM GPU smoke resolved to a fallback or non-GPU runtime")
    if outcome.get("status") != "completed" or outcome.get("exit_code") != 0:
        raise VerificationError("FEM GPU smoke did not complete successfully")
    script = receipt.get("script")
    if not isinstance(script, dict) or str(script.get("path", "")).replace("\\", "/") != (
        "/opt/fullmag/source/examples/fem_relax_gpu_smoke.py"
    ):
        raise VerificationError("FEM GPU smoke receipt names an unexpected script")
    result = receipt.get("results")
    result_dir = result.get("dir") if isinstance(result, dict) else None
    expected_output = container_root.rstrip("/") + "/output"
    normalized_result_dir = result_dir.replace("\\", "/") if isinstance(result_dir, str) else ""
    if not normalized_result_dir == expected_output and not normalized_result_dir.startswith(
        expected_output + "/"
    ):
        raise VerificationError("FEM GPU smoke result directory escaped its explicit output root")
    return {
        "status": "PASS",
        "requested_device": effective.get("device"),
        "resolved_device": resolved.get("device"),
        "resolved_backend": resolved.get("backend"),
        "resolved_precision": resolved.get("precision"),
        "fallback": resolved.get("fallback"),
        "steps": 4,
        "results_dir": result_dir,
        "receipt": str(path),
    }


def _session_environment(state_root: str, image: str) -> dict[str, str]:
    return {
        "FULLMAG_STATE_ROOT": state_root,
        "FULLMAG_SESSION_STORAGE_PROFILE": "windows-folder-v1",
        "FULLMAG_RUNTIME_IMAGE_ID": image,
        "FULLMAG_REPO_ROOT": "/opt/fullmag/source",
    }


def _run_session_roundtrip(
    container: str,
    image: str,
    container_root: str,
    host_root: Path,
    log_root: Path,
) -> dict[str, Any]:
    save_root = f"{container_root}/session-save-state"
    open_root = f"{container_root}/session-open-state"
    save_state_host = host_root / "session-save-state"
    open_state_host = host_root / "session-open-state"
    archive_container = f"{container_root}/session.fms"
    archive_host = host_root / "session.fms"
    save_environment = _session_environment(save_root, image)
    open_environment = _session_environment(open_root, image)
    _docker_exec(
        container,
        ("mkdir", "-p", f"{save_root}/local-live/session-store/project", open_root),
        timeout=30.0,
        log_root=log_root,
        log_name="session-prepare",
    )
    _docker_exec(
        container,
        (
            "cp",
            "/opt/fullmag/source/examples/fem_relax_gpu_smoke.py",
            f"{save_root}/local-live/session-store/project/main.py",
        ),
        timeout=30.0,
        log_root=log_root,
        log_name="session-seed-project",
    )
    _docker_exec(
        container,
        (
            "/opt/fullmag/package/bin/fullmag-bin",
            "session",
            "save",
            archive_container,
            "--profile",
            "resume",
            "--name",
            "docker-all-runtime-smoke",
        ),
        timeout=180.0,
        log_root=log_root,
        log_name="session-save",
        environment=save_environment,
    )
    _docker_exec(
        container,
        ("/opt/fullmag/package/bin/fullmag-bin", "session", "inspect", archive_container),
        timeout=120.0,
        log_root=log_root,
        log_name="session-inspect",
        environment=save_environment,
    )
    _docker_exec(
        container,
        ("/opt/fullmag/package/bin/fullmag-bin", "session", "open", archive_container),
        timeout=180.0,
        log_root=log_root,
        log_name="session-open",
        environment=open_environment,
    )
    from windows_folder_host import read_owned_regular

    archive_bytes = read_owned_regular(archive_host, maximum=MAX_FMS_BYTES)
    if not archive_bytes:
        raise VerificationError("FMS archive was not durably published in the owned state")
    opened_store = storage.validate_path(
        open_state_host / "local-live/session-store", host_root, "opened session store"
    )
    if not opened_store.is_dir() or storage.is_link(opened_store):
        raise VerificationError("session open did not publish the isolated destination store")
    inspect_stdout = (log_root / "session-inspect.stdout.log").read_text(
        encoding="utf-8", errors="replace"
    )
    open_stdout = (log_root / "session-open.stdout.log").read_text(
        encoding="utf-8", errors="replace"
    )
    if "format:" not in inspect_stdout or "Session imported:" not in open_stdout:
        raise VerificationError("FMS inspect/open output did not confirm the real CLI round-trip")
    return {
        "status": "PASS",
        "archive": str(archive_host),
        "save_state_root": str(save_state_host),
        "open_state_root": str(open_state_host),
        "interface": "fullmag session save/inspect/open",
        "direct_windows_storage": "PASS",
    }


def _stat_evidence(container: str, grant: Mapping[str, Any], log_root: Path) -> dict[str, Any]:
    device_result = _docker_exec(
        container,
        ("stat", "-c", "%d:%i", "/state"),
        timeout=30.0,
        log_root=log_root,
        log_name="state-stat",
    )
    namespace_result = _docker_exec(
        container,
        ("stat", "-Lc", "%i", "/proc/self/ns/mnt"),
        timeout=30.0,
        log_root=log_root,
        log_name="mount-namespace-stat",
    )
    raw_device, raw_inode = _decode(device_result.stdout).strip().split(":", 1)
    if int(raw_device) != grant["root_device"] or int(raw_inode) != grant["root_inode"]:
        raise VerificationError("container /state identity differs from the Windows-folder grant")
    if int(_decode(namespace_result.stdout).strip()) != grant["mount_namespace_inode"]:
        raise VerificationError("container mount namespace differs from the Windows-folder grant")
    filesystem = _decode(
        _docker_exec(
            container,
            ("stat", "-f", "-c", "%t", "/state"),
            timeout=30.0,
            log_root=log_root,
            log_name="state-filesystem-stat",
        ).stdout
    ).strip().lower().lstrip("0")
    if filesystem != "1021997":
        raise VerificationError(f"container /state filesystem is not the expected Windows bind 9p: {filesystem}")
    return {
        "root_device": grant["root_device"],
        "root_inode": grant["root_inode"],
        "mount_namespace_inode": grant["mount_namespace_inode"],
        "filesystem_magic": filesystem,
        "direct_storage": "PASS",
    }


def verify(repo: Path, run_receipt: Path, *, timeout_seconds: int = 3600) -> dict[str, Any]:
    if os.name != "nt":
        raise VerificationError("run this verifier with native Windows Python so Docker Desktop and NTFS attestation are visible")
    if not 1 <= timeout_seconds <= 24 * 3600:
        raise VerificationError("timeout_seconds must be between 1 and 86400")
    receipt, assembly, layout, run_root, state, assembly_path = _validate_run_bundle(
        repo.resolve(), run_receipt
    )
    container = str(receipt["container_id"])
    image = str(receipt["image_id"])
    with storage.build_lock(layout):
        # Re-read after acquiring the worktree lock.  A concurrent launcher or
        # operator must never turn this verifier into a foreign-container probe.
        receipt, assembly, layout, run_root, state, assembly_path = _validate_run_bundle(
            repo.resolve(), run_receipt
        )
        container = str(receipt["container_id"])
        image = str(receipt["image_id"])
        verification_id = uuid.uuid4().hex
        verification_root = storage.validate_path(
            state / "verification" / verification_id, state, "runtime verification root"
        )
        verification_root.parent.mkdir(exist_ok=True)
        verification_root.mkdir(exist_ok=False, mode=0o700)
        if storage.is_link(verification_root):
            raise VerificationError("runtime verification root is a link or reparse point")
        container_root = f"/state/verification/{verification_id}"
        smoke_receipt_host = verification_root / "fem-gpu-receipt.json"
        verifier_receipt_path = verification_root / "verification-receipt.json"
        verifier: dict[str, Any] = {
            "schema": VERIFICATION_SCHEMA,
            "state": "starting",
            "qualification": QUALIFICATION,
            "run_receipt": str(Path(run_receipt).resolve()),
            "run_root": str(run_root),
            "container_id": container,
            "image_id": image,
            "assembly_receipt": str(assembly_path),
            "source_commit": assembly["commit"],
            "verification_id": verification_id,
            "container_verification_root": container_root,
            "logs_root": str(verification_root),
            "unit_tests_compiled": False,
            "resources_retained_on_failure": True,
        }
        _write_json(verifier_receipt_path, verifier)
        try:
            verifier["storage_attestation"] = _validate_storage_attestation(
                receipt, assembly, run_root, state
            )
            document, container_attestation = _validate_container(
                receipt, assembly, run_root, state, verification_root
            )
            verifier["host_ledger_attestation"] = _validate_host_ledger_attestation(
                receipt, document, run_root
            )
            verifier["container_attestation"] = {
                "running": document["State"]["Running"],
                "frontend_mode": container_attestation["frontend_mode"],
                "backend_container_id": container,
                "frontend_container_id": container_attestation["frontend_container_id"],
                "backend_api_port": container_attestation["backend_port"],
                "public_loopback_port": container_attestation["port"],
                "gpu_request": "PASS",
                "isolation": "PASS",
                "image_provenance": "PASS",
                "binary_hashes": container_attestation["binary_hashes"],
                "frontend": container_attestation["frontend"],
            }
            verifier["python_dsl"] = _python_probe(container, verification_root)
            readiness_timeout = min(90.0, timeout_seconds)
            if container_attestation["frontend_mode"] == "dev":
                backend_readiness = _wait_backend_ready(
                    container, readiness_timeout, verification_root
                )
                public_readiness = _wait_public_openapi(
                    container_attestation["port"], readiness_timeout
                )
                readiness = {
                    "status": "PASS",
                    "backend_internal": backend_readiness,
                    "public_frontend": public_readiness,
                }
            else:
                readiness = {
                    "status": "PASS",
                    **_wait_http_ready(container_attestation["port"], readiness_timeout),
                }
            verifier["api_readiness"] = readiness
            verifier["accepted_store"] = _validate_rust_accepted_store(
                container,
                container_attestation["port"],
                assembly["commit"],
                verification_root,
            )
            _docker_exec(
                container,
                ("mkdir", "-p", container_root + "/output", container_root + "/workspace"),
                timeout=30.0,
                log_root=verification_root,
                log_name="smoke-prepare",
            )
            smoke_result = _docker_exec(
                container,
                _verification_command(container_root, container_root + "/fem-gpu-receipt.json"),
                timeout=float(timeout_seconds),
                log_root=verification_root,
                log_name="fem-gpu-smoke",
                environment={
                    "FULLMAG_RELAX_ALGORITHM": "projected_gradient_bb",
                    "FULLMAG_RELAX_DEVICE": "gpu",
                    "FULLMAG_RELAX_MAX_STEPS": "4",
                    "FULLMAG_RELAX_ENABLE_DEMAG": "1",
                    "FULLMAG_FEM_REQUIRE_GPU": "1",
                },
            )
            verifier["fem_gpu_smoke"] = _validate_gpu_smoke_receipt(
                smoke_receipt_host, container_root
            )
            verifier["fem_gpu_smoke"]["stdout_bytes"] = len(smoke_result.stdout)
            verifier["fem_gpu_smoke"]["stderr_bytes"] = len(smoke_result.stderr)
            from windows_folder_host import read_owned_regular

            grant = _parse_json_bytes(
                read_owned_regular(state / ".fullmag-windows-folder-grant.json"),
                "Windows session grant",
            )
            if not isinstance(grant, dict):
                raise VerificationError("Windows session grant must contain a JSON object")
            verifier["direct_storage"] = _stat_evidence(container, grant, verification_root)
            verifier["session_roundtrip"] = _run_session_roundtrip(
                container, image, container_root, verification_root, verification_root
            )
            verifier["state"] = "succeeded"
            verifier["health"] = "PASS"
        except DockerTimeout as error:
            verifier.update(
                state="failed_resources_retained",
                runtime_outcome="unknown_timeout",
                error=str(error),
            )
            verification_root.joinpath("verification-error.log").write_text(
                str(error) + "\n", encoding="utf-8"
            )
            raise
        except Exception as error:
            verifier.update(state="failed_resources_retained", error=str(error))
            verification_root.joinpath("verification-error.log").write_text(
                str(error) + "\n", encoding="utf-8"
            )
            raise
        finally:
            _write_json(verifier_receipt_path, verifier)
            print(json.dumps({"receipt": str(verifier_receipt_path), **verifier}, indent=2))
        return verifier


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("run_receipt", type=Path, help="receipt.json produced by docker-all start")
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    args = parser.parse_args(argv)
    try:
        verify(args.repo_root, args.run_receipt, timeout_seconds=args.timeout_seconds)
    except Exception as error:
        print(f"Docker runtime verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
