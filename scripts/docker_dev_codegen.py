#!/usr/bin/env python3
"""Run managed OpenAPI/TypeScript codegen through fixed DEV services.

The command admits the already-running backend and frontend for one registered
checkout. It never invokes Compose lifecycle operations. Backend output is
staged in the frontend named-volume state, existing generators run there, and
only the four generated source artifacts are written back to the checkout.
Receipts and temporary staging remain in Docker volumes.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
import argparse
import hashlib
import json
import os
import posixpath
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any

from docker_named_volume_safety import (
    DockerNamedVolumeSafetyError,
    validate_local_named_volume,
)

MAX_OPENAPI_BYTES = 64 * 1024 * 1024
MAX_RECEIPT_BYTES = 16 * 1024 * 1024
MAX_TOOL_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_GENERATED_BYTES = 64 * 1024 * 1024
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CONTROL_NAMESPACE_RE = re.compile(r"^namespaces/[0-9a-f]{32}$")
DIRECT_CODEGEN_SCHEMA = "fullmag.direct-compose-openapi-codegen.v1"
FAILURE_RECEIPT_PATH = "/opt/fullmag/control/backend/codegen/openapi-v2/last-failure.json"

SOURCE_PROBE_SCRIPT = r'''
import shutil
import sys
from pathlib import Path
sys.path.insert(0, "/opt/fullmag")
from backend_source import capture_live_source_manifest

token = sys.argv[1]
if not token or any(character not in "0123456789abcdef-" for character in token):
    raise SystemExit("invalid source probe token")
root = Path("/build/codegen-source-probe") / token
root.mkdir(parents=True, exist_ok=True)
try:
    manifest = capture_live_source_manifest(
        Path("/opt/fullmag/source"), Path("/opt/fullmag/source-git"), root
    )
    raw = manifest.read_bytes()
    if len(raw) > 64 * 1024 * 1024:
        raise RuntimeError("live source manifest exceeds its bound")
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.write(b"\n")
finally:
    shutil.rmtree(root, ignore_errors=False)
'''
BACKEND_DOCUMENTS_SCRIPT = r'''
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
            raise RuntimeError("handoff is not one regular file")
        if metadata.st_size <= 0 or metadata.st_size > MAXIMUM:
            raise RuntimeError("handoff exceeds its size bound")
        data = bytearray()
        while len(data) <= MAXIMUM:
            block = os.read(descriptor, min(1024 * 1024, MAXIMUM + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        if len(data) > MAXIMUM:
            raise RuntimeError("handoff exceeds its size bound")
        raw = bytes(data)
        return {"value": json.loads(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    finally:
        os.close(descriptor)

def digest_binary(name):
    descriptor = os.open("/opt/fullmag/package/bin/" + name, FLAGS)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise RuntimeError("runtime binary is not one regular file")
        digest = hashlib.sha256()
        total = 0
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > 16 * 1024 * 1024 * 1024:
                raise RuntimeError("runtime binary exceeds its size bound")
            digest.update(block)
        return digest.hexdigest()
    finally:
        os.close(descriptor)

print(json.dumps({
    "receipt": read("/opt/fullmag/package/backend-build-receipt.json"),
    "provenance": read("/opt/fullmag/control/backend/runtime-provenance.json"),
    "api_binary_sha256": digest_binary("fullmag-api"),
}, separators=(",", ":")))
'''
ATOMIC_WRITE_SCRIPT = r'''
import os
from pathlib import Path
import sys
import tempfile

target = Path(sys.argv[1])
root = Path("/state/development/codegen")
try:
    relative = target.relative_to(root)
except ValueError as error:
    raise SystemExit("codegen staging path escapes the frontend state volume") from error
if any(part in {"", ".", ".."} for part in relative.parts):
    raise SystemExit("codegen staging path contains an unsafe component")
if target.is_symlink() or (target.exists() and not target.is_file()):
    raise SystemExit("codegen staging target is not a regular file")
target.parent.mkdir(parents=True, exist_ok=True)
data = sys.stdin.buffer.read(64 * 1024 * 1024 + 1)
if len(data) > 64 * 1024 * 1024:
    raise SystemExit("codegen staging payload exceeds its bound")
fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    os.fchmod(fd, 0o640)
    with os.fdopen(fd, "wb", closefd=True) as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
'''
ATOMIC_CONTROL_WRITE_SCRIPT = r'''
import json
import os
from pathlib import Path
import sys
import tempfile

target = Path(sys.argv[1])
root = Path("/opt/fullmag/control")
try:
    relative = target.relative_to(root)
except ValueError as error:
    raise SystemExit("codegen receipt path escapes the control volume") from error
if any(part in {"", ".", ".."} for part in relative.parts):
    raise SystemExit("codegen receipt path contains an unsafe component")
if target.is_symlink() or (target.exists() and not target.is_file()):
    raise SystemExit("codegen receipt target is not a regular file")
target.parent.mkdir(parents=True, exist_ok=True)
value = json.load(sys.stdin)
raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    with os.fdopen(fd, "wb", closefd=True) as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
'''
CLEANUP_SCRIPT = r'''
from pathlib import Path
import shutil
import sys

root = Path("/state/development/codegen") / sys.argv[1]
if root.is_symlink() or (root.exists() and not root.is_dir()):
    raise SystemExit("codegen staging root is not a directory")
if root.exists():
    shutil.rmtree(root)
'''


class CodegenError(RuntimeError):
    """The existing DEV services did not satisfy the codegen contract."""

    def __init__(self, message: str, *, reconciliation_required: bool = False,
                 stdout: bytes = b"", stderr: bytes = b"", exit_code: int | None = None) -> None:
        super().__init__(message)
        self.reconciliation_required = reconciliation_required
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _output_snapshot_sha256(outputs: Mapping[str, bytes]) -> str:
    hashes = {name: _sha256(outputs[name]) for name in sorted(outputs)}
    return _sha256(_canonical_json(hashes))


def _codegen_receipt_key(
    source_identity: Mapping[str, Any],
    raw_openapi_sha256: str,
    frontend_inputs_sha256: str,
    tool_versions: Mapping[str, str],
) -> str:
    """Return the stable key for one identical codegen input set.

    The staging directory is deliberately ephemeral.  It must never become a
    part of the receipt identity, otherwise repeated codegen of the same
    inputs would leave an unbounded sequence of equivalent receipts.
    """
    payload = {
        "schema": "fullmag.direct-compose-openapi-receipt-key.v1",
        "source_identity": dict(source_identity),
        "raw_openapi_sha256": raw_openapi_sha256,
        "frontend_codegen_inputs_sha256": frontend_inputs_sha256,
        "frontend_tool_versions": dict(tool_versions),
    }
    return _sha256(_canonical_json(payload))


def _bounded_failure_message(error: BaseException, limit: int = 1024) -> str:
    message = " ".join(str(error).split())
    if len(message) > limit:
        return message[: limit - 3] + "..."
    return message


def _failure_receipt_document(
    *,
    project: str,
    phase: str,
    error: BaseException,
    backend_id: str | None,
    frontend_id: str | None,
    stage: str | None,
    cleanup_state: str,
    started: float,
    service_identities: Mapping[str, Mapping[str, str]] | None = None,
    published: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Build a bounded failure receipt without copying command output."""
    reconciliation_required = bool(getattr(error, "reconciliation_required", False))
    return {
        "schema": DIRECT_CODEGEN_SCHEMA,
        "state": "failed",
        "outcome": "unknown"
        if reconciliation_required or cleanup_state in {"pending", "unknown", "failed"}
        else "failed",
        "exit_code": 2,
        "compose_project": project,
        "phase": phase,
        "error": {
            "type": type(error).__name__,
            "message": _bounded_failure_message(error),
            "reconciliation_required": reconciliation_required,
        },
        "services": {
            "backend_container_id": backend_id,
            "frontend_container_id": frontend_id,
            "identities": dict(service_identities or {}),
        },
        "published": dict(published) if published is not None else None,
        "staging": {
            "stage_id": stage,
            "volume_path": f"/state/development/codegen/{stage}" if stage else None,
            "cleanup_state": cleanup_state,
            "cleanup_confirmed": cleanup_state == "confirmed",
            "reconciliation_required": reconciliation_required,
        },
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _docker_argv(arguments: Sequence[object]) -> list[str]:
    command = ["docker"]
    if os.name == "nt":
        command.extend(("--context", "desktop-linux"))
    return command + [str(value) for value in arguments]


def _capture(arguments: Sequence[object], *, timeout: int = 120,
             input_bytes: bytes | None = None,
             stdout_limit: int = MAX_TOOL_OUTPUT_BYTES,
             stderr_limit: int = MAX_TOOL_OUTPUT_BYTES) -> tuple[bytes, bytes]:
    """Capture both Docker client streams with independent bounded buffers.

    Killing this process only stops the local Docker client. It does not issue
    a stop/remove request for an already admitted container or remote exec.
    """
    command = _docker_argv(arguments)
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    output = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": stdout_limit, "stderr": stderr_limit}
    overflow = threading.Event()
    overflow_name: list[str] = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def drain(stream, name: str) -> None:
        try:
            while True:
                chunk = stream.read1(65536)
                if not chunk:
                    return
                with lock:
                    remaining = limits[name] - len(output[name])
                    if len(chunk) > remaining:
                        if remaining > 0:
                            output[name].extend(chunk[:remaining])
                        overflow_name.append(name)
                        overflow.set()
                        return
                    output[name].extend(chunk)
        except BaseException as error:  # pragma: no cover - OS-specific pipe failures
            errors.append(error)

    threads = [
        threading.Thread(target=drain, args=(stream, name), daemon=True)
        for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr"))
    ]
    for thread in threads:
        thread.start()

    if input_bytes is not None:
        def feed_input() -> None:
            try:
                assert process.stdin is not None
                process.stdin.write(input_bytes)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        input_thread = threading.Thread(target=feed_input, daemon=True)
        input_thread.start()
    else:
        input_thread = None

    deadline = time.monotonic() + timeout
    interrupted: str | None = None
    try:
        while process.poll() is None:
            if overflow.wait(0.025):
                interrupted = f"Docker client output limit exceeded ({overflow_name[0]})"
                break
            if errors:
                interrupted = "Docker client output could not be read"
                break
            if time.monotonic() >= deadline:
                interrupted = f"Docker command timed out after {timeout}s"
                break
    finally:
        if process.poll() is None:
            # Bound only the client observation. The daemon-side operation may
            # already have been admitted and remains for explicit reconciliation.
            process.kill()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        for thread in threads:
            thread.join(timeout=1)
        if input_thread is not None:
            input_thread.join(timeout=1)
        for stream, thread in zip((process.stdout, process.stderr), threads):
            if not thread.is_alive():
                stream.close()

    if interrupted or overflow.is_set() or errors or any(thread.is_alive() for thread in threads):
        detail = interrupted or "Docker client output could not be read within its bound"
        raise CodegenError(
            detail + "; daemon operation may require explicit reconciliation",
            reconciliation_required=True,
        )
    stdout = bytes(output["stdout"])
    stderr = bytes(output["stderr"])
    if process.returncode:
        message = stderr.decode("utf-8", "replace").strip() or stdout.decode("utf-8", "replace").strip()
        raise CodegenError(message or f"Docker command failed ({process.returncode})",
                           stdout=stdout, stderr=stderr, exit_code=process.returncode)
    return stdout, stderr


def _exec(container: str, arguments: Sequence[object], *, timeout: int = 120,
          input_bytes: bytes | None = None, stdout_limit: int = MAX_TOOL_OUTPUT_BYTES,
          stderr_limit: int = MAX_TOOL_OUTPUT_BYTES, workdir: str | None = None,
          environment: Mapping[str, str] | None = None) -> tuple[bytes, bytes]:
    command: list[object] = ["exec"]
    if input_bytes is not None:
        command.append("-i")
    if workdir is not None:
        command.extend(("-w", workdir))
    for key, value in (environment or {}).items():
        command.extend(("-e", f"{key}={value}"))
    command.append(container)
    command.extend(arguments)
    return _capture(command, timeout=timeout, input_bytes=input_bytes,
                    stdout_limit=stdout_limit, stderr_limit=stderr_limit)


def _inspect(container: str) -> dict[str, Any]:
    stdout, _ = _capture(("inspect", container), timeout=30, stdout_limit=4 * 1024 * 1024)
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise CodegenError("Docker inspect returned invalid JSON") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise CodegenError("Docker inspect returned an unexpected document")
    return value[0]


def _labels(document: Mapping[str, Any]) -> Mapping[str, Any]:
    config = document.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if not isinstance(labels, Mapping):
        raise CodegenError("running service has no Compose labels")
    return labels


def _path_identity(value: object) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.replace("\\", "/").rstrip("/").lower()
    match = re.fullmatch(r"/(?:mnt|host_mnt|run/desktop/mnt/host)/([a-z])/(.*)", normalized)
    if match:
        normalized = f"{match.group(1)}:/{match.group(2)}"
    return normalized


def _environment(document: Mapping[str, Any]) -> dict[str, str]:
    config = document.get("Config")
    values = config.get("Env") if isinstance(config, Mapping) else None
    if not isinstance(values, list):
        return {}
    result: dict[str, str] = {}
    for item in values:
        if isinstance(item, str) and "=" in item:
            key, value = item.split("=", 1)
            result[key] = value
    return result


def _control_namespace(value: object) -> str:
    if not isinstance(value, str) or (value and CONTROL_NAMESPACE_RE.fullmatch(value) is None):
        raise CodegenError("backend control namespace is not canonical")
    return value


def _control_subpath(namespace: str, relative: str = "") -> str:
    namespace = _control_namespace(namespace)
    if not relative:
        return namespace
    if relative.startswith("/") or "\\" in relative or any(
        part in {"", ".", ".."} for part in relative.split("/")
    ):
        raise CodegenError("control mount relative path is not canonical")
    return f"{namespace}/{relative}" if namespace else relative


def _backend_control_namespace(document: Mapping[str, Any]) -> str:
    return _control_namespace(_environment(document).get("FULLMAG_CONTROL_NAMESPACE", ""))


def _validate_mounts(
    document: Mapping[str, Any], service: str, control_namespace: str | None = None
) -> None:
    mounts = document.get("Mounts")
    if not isinstance(mounts, list):
        raise CodegenError(f"{service} service has no inspected mounts")

    def mount_for(target: str) -> Mapping[str, Any]:
        for mount in mounts:
            if isinstance(mount, Mapping) and mount.get("Destination") == target:
                return mount
        raise CodegenError(f"{service} required mount is missing: {target}")

    source_targets = ["/opt/fullmag/source"]
    if service == "backend":
        source_targets.append("/opt/fullmag/source-git")
    for target in source_targets:
        mount = mount_for(target)
        if mount.get("Type") != "bind" or mount.get("RW") is not False:
            raise CodegenError(f"{service} source mount is not a readonly bind: {target}")

    volume_targets = (
        ("/build", "/opt/fullmag/package", "/opt/fullmag/control")
        if service == "backend"
        else ("/state/development", "/opt/fullmag/control")
    )
    for target in volume_targets:
        mount = mount_for(target)
        writable = not (service == "frontend" and target == "/opt/fullmag/control")
        if mount.get("Type") != "volume" or mount.get("RW") is not writable:
            access = "writable" if writable else "readonly"
            raise CodegenError(f"{service} technical mount is not a {access} named volume: {target}")

    environment = _environment(document)
    if service == "backend":
        observed_namespace = _backend_control_namespace(document)
        if control_namespace is not None and observed_namespace != control_namespace:
            raise CodegenError("backend control namespace differs from its verified environment")
    elif control_namespace is not None:
        frontend_namespace = environment.get("FULLMAG_CONTROL_NAMESPACE")
        if frontend_namespace is not None and _control_namespace(frontend_namespace) != control_namespace:
            raise CodegenError("frontend control namespace differs from the backend environment")


def _validate_admitted_source_mount(
    project: str, service: str, identity: Mapping[str, str], selected: Path,
    document: Mapping[str, Any],
) -> None:
    """Authenticate daemon aliases against the exact succeeded DEV admission."""
    from bootstrap_docker_toolchain import control_volume_name
    from docker_build_control import BuildControlError, MAX_DOCUMENT_BYTES, canonical, control_read_script
    from docker_volume_dev import _validate_retained_service

    observed = {service: document}

    def running(role: str) -> Mapping[str, Any]:
        if role not in observed:
            raw, _ = _capture((
                "ps", "--quiet", "--filter", "status=running",
                "--filter", f"label=com.docker.compose.project={project}",
                "--filter", f"label=com.docker.compose.service={role}",
            ), timeout=30, stdout_limit=64 * 1024)
            ids = raw.decode().split()
            if len(ids) != 1:
                raise CodegenError(f"admission requires one current {role} service")
            observed[role] = _inspect(ids[0])
        return observed[role]

    backend = running("backend")
    control_mount = _mount_for(backend, "/opt/fullmag/control")
    namespace = _backend_control_namespace(backend)
    if (control_mount.get("Type") != "volume"
            or control_mount.get("Name") != control_volume_name(project)
            or _mount_subpath(backend, control_mount, "/opt/fullmag/control") != (namespace or None)):
        raise CodegenError("admission control mount does not belong to this Compose group")
    backend_id = backend.get("Id")
    if not isinstance(backend_id, str) or SHA256_RE.fullmatch(backend_id) is None:
        raise CodegenError("admission backend has no full container identity")

    def read(relative: str) -> tuple[bytes, dict[str, Any]]:
        script = control_read_script("/control/" + relative)
        # The same control-volume root is mounted inside this fixed backend;
        # reading it must not launch a helper or create a new operation.
        script = script.replace("/control", "/opt/fullmag/control")
        raw, _ = _exec(backend_id, ("/bin/bash", "-euo", "pipefail", "-c", script),
                       timeout=90, stdout_limit=MAX_DOCUMENT_BYTES + 1)
        return raw, _read_json_bytes(raw, "DEV admission " + relative, MAX_DOCUMENT_BYTES)

    receipt_raw, receipt = read("development/verified.json")
    attempt = receipt.get("attempt")
    inputs = receipt.get("inputs")
    if (receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or receipt.get("phase") != "development" or receipt.get("state") != "succeeded"
            or receipt.get("compose_project") != project
            or not isinstance(attempt, str) or re.fullmatch(r"[0-9a-f]{32}", attempt) is None
            or not isinstance(inputs, Mapping)
            or _path_identity(inputs.get("source_root")) != _path_identity(str(selected))
            or any(inputs.get("source_" + key) != identity[key]
                   for key in ("project_id", "worktree_id", "checkout_kind"))):
        raise CodegenError("DEV admission does not authenticate the selected checkout")
    root = "development/attempts/" + attempt
    terminal_raw, _ = read(root + "/terminal.json")
    _, compose = read(root + "/compose.json")
    if (terminal_raw != receipt_raw or compose.get("name") != project
            or _sha256(canonical(compose)) != receipt.get("config_sha256")):
        raise CodegenError("DEV admission terminal or Compose digest differs")
    try:
        for role in ("backend", "frontend"):
            actual = running(role)
            expected = compose["services"][role]
            actual_id = actual.get("Id")
            if (not isinstance(actual_id, str) or SHA256_RE.fullmatch(actual_id) is None
                    or actual_id != receipt.get(role + "_container")
                    or actual.get("State", {}).get("Running") is not True
                    or actual.get("Image") != expected["image"]):
                raise CodegenError("DEV admission service incarnation or image differs: " + role)
            source = next(mount for mount in expected["volumes"]
                          if mount.get("target") == "/opt/fullmag/source")
            pinned = expected.get("x-fullmag-daemon-binds", {}).get("/opt/fullmag/source")
            if (source.get("type") != "bind" or source.get("read_only") is not True
                    or _path_identity(source.get("source")) != _path_identity(str(selected))
                    or not isinstance(pinned, str) or not pinned
                    or _mount_for(actual, "/opt/fullmag/source").get("Source") != pinned):
                raise CodegenError("DEV admission source declaration or daemon bind differs: " + role)
            image = _inspect(actual["Image"])
            if image.get("Id") != actual["Image"]:
                raise CodegenError("DEV admission image inspection differs")
            _validate_retained_service(compose, actual, role, image["Config"])
    except (BuildControlError, KeyError, TypeError, StopIteration) as error:
        raise CodegenError("DEV admission service validation failed: " + str(error)) from error
    if read("development/verified.json")[0] != receipt_raw:
        raise CodegenError("DEV admission changed during source mount validation")


def _running_service(
    project: str,
    service: str,
    identity: Mapping[str, str],
    selected: Path,
    control_namespace: str | None = None,
) -> tuple[str, dict[str, Any]]:
    stdout, _ = _capture((
        "ps", "--quiet", "--filter", "status=running",
        "--filter", f"label=com.docker.compose.project={project}",
        "--filter", f"label=com.docker.compose.service={service}",
    ), timeout=30, stdout_limit=64 * 1024)
    containers = [line.strip() for line in stdout.decode().splitlines() if line.strip()]
    if len(containers) != 1:
        raise CodegenError(f"expected one running {service} service in Compose group {project}, found {len(containers)}")
    container = containers[0]
    document = _inspect(container)
    state = document.get("State")
    if not isinstance(state, Mapping) or state.get("Running") is not True:
        raise CodegenError(f"{service} service is not running")
    labels = _labels(document)
    expected_labels = {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
        "org.fullmag.compose.project": project,
        "org.fullmag.source.project-id": identity["project_id"],
        "org.fullmag.source.worktree-id": identity["worktree_id"],
        "org.fullmag.source.checkout-kind": identity["checkout_kind"],
    }
    if any(labels.get(key) != value for key, value in expected_labels.items()):
        raise CodegenError(f"{service} service labels do not match selected checkout")
    environment = _environment(document)
    if service == "backend":
        observed_namespace = _backend_control_namespace(document)
        if control_namespace is not None and observed_namespace != control_namespace:
            raise CodegenError("backend control namespace changed during service selection")
        control_namespace = observed_namespace
    elif control_namespace is not None:
        control_namespace = _control_namespace(control_namespace)
    _validate_mounts(document, service, control_namespace)
    source_env_name = "FULLMAG_SOURCE_HOST_ROOT" if service == "backend" else "FULLMAG_SOURCE_ROOT"
    source_root = environment.get(source_env_name)
    if not source_root or _path_identity(source_root) != _path_identity(str(selected)):
        raise CodegenError(f"{service} service environment is mounted from a different source checkout")
    source_mount = _mount_for(document, "/opt/fullmag/source")
    if _path_identity(source_mount.get("Source")) != _path_identity(str(selected)):
        _validate_admitted_source_mount(project, service, identity, selected, document)
    return container, document


def _mount_for(document: Mapping[str, Any], target: str) -> Mapping[str, Any]:
    mounts = document.get("Mounts")
    if not isinstance(mounts, list):
        raise CodegenError("container has no inspected mounts")
    for mount in mounts:
        if isinstance(mount, Mapping) and mount.get("Destination") == target:
            return mount
    raise CodegenError(f"required inspected mount is missing: {target}")


def _service_identity(container: str, document: Mapping[str, Any]) -> dict[str, str]:
    image = document.get("Image")
    config = document.get("Config")
    config_image = config.get("Image") if isinstance(config, Mapping) else None
    if not isinstance(image, str) or not image or not isinstance(config_image, str) or not config_image:
        raise CodegenError("running service has no immutable container/image identity")
    return {"container_id": container, "image_id": image, "config_image": config_image}


def _mount_subpath(
    document: Mapping[str, Any], mount: Mapping[str, Any], target: str
) -> str | None:
    """Read a volume subpath from either inspect representation.

    Docker's top-level ``.Mounts`` normalizes a volume mount to its root
    mountpoint and omits ``VolumeOptions.Subpath``.  The authoritative
    subpath is retained in ``.HostConfig.Mounts`` and must be correlated to
    the same target and named volume before it is accepted.
    """
    values: list[str] = []
    for key in ("SubPath", "Subpath", "subpath"):
        value = mount.get(key)
        if value is not None:
            if not isinstance(value, str):
                raise CodegenError("inspected volume subpath is malformed")
            values.append(value)
    for key in ("VolumeOptions", "volume_options", "volume"):
        value = mount.get(key)
        if isinstance(value, Mapping):
            for nested in ("SubPath", "Subpath", "subpath"):
                nested_value = value.get(nested)
                if nested_value is not None:
                    if not isinstance(nested_value, str):
                        raise CodegenError("inspected volume subpath is malformed")
                    values.append(nested_value)

    host_config = document.get("HostConfig")
    host_mounts = host_config.get("Mounts") if isinstance(host_config, Mapping) else None
    if not isinstance(host_mounts, list):
        if values and any(value != values[0] for value in values[1:]):
            raise CodegenError("inspected volume subpath observations disagree")
        return values[0] if values else None
    matches = [
        item for item in host_mounts
        if isinstance(item, Mapping) and item.get("Target") == target
    ]
    if len(matches) > 1:
        raise CodegenError("inspected volume has ambiguous HostConfig mounts")
    if matches:
        host_mount = matches[0]
        if host_mount.get("Type") != "volume" or host_mount.get("Source") != mount.get("Name"):
            raise CodegenError("inspected HostConfig volume identity differs")
        volume_options = host_mount.get("VolumeOptions")
        if volume_options is not None and not isinstance(volume_options, Mapping):
            raise CodegenError("inspected HostConfig volume options are malformed")
        if isinstance(volume_options, Mapping):
            value = volume_options.get("Subpath", volume_options.get("SubPath", volume_options.get("subpath")))
            if value is not None:
                if not isinstance(value, str):
                    raise CodegenError("inspected HostConfig volume subpath is malformed")
                values.append(value)
    if values and any(value != values[0] for value in values[1:]):
        raise CodegenError("inspected volume subpath observations disagree")
    return values[0] if values else None


def _volume_name(mount: Mapping[str, Any], service: str, target: str) -> str:
    value = mount.get("Name")
    if not isinstance(value, str) or not value:
        raise CodegenError(f"{service} volume mount has no named-volume identity: {target}")
    return value


def _validate_control_mount_subpath(
    document: Mapping[str, Any],
    mount: Mapping[str, Any],
    target: str,
    volume_document: Mapping[str, Any],
    expected_subpath: str,
) -> str:
    observed = _mount_subpath(document, mount, target)
    source = mount.get("Source")
    mountpoint = volume_document.get("Mountpoint")
    if not isinstance(mountpoint, str) or not mountpoint.startswith("/"):
        raise CodegenError("control volume inspect has no usable root mountpoint")
    root = posixpath.normpath(mountpoint)
    expected_source = posixpath.normpath(
        posixpath.join(mountpoint, expected_subpath) if expected_subpath else mountpoint
    )
    if observed is not None:
        if observed != expected_subpath:
            raise CodegenError(f"control mount has the wrong volume subpath: {target}")
        if source is not None:
            if not isinstance(source, str) or posixpath.normpath(source) not in {root, expected_source}:
                raise CodegenError(f"control mount source disagrees with its subpath: {target}")
        return expected_subpath
    if not isinstance(source, str) or posixpath.normpath(source) != expected_source:
        raise CodegenError(f"control mount source does not prove its exact subpath: {target}")
    return expected_subpath


def _inspect_named_volume(name: str) -> dict[str, Any]:
    stdout, _ = _capture(("volume", "inspect", name), timeout=30, stdout_limit=4 * 1024 * 1024)
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise CodegenError(f"Docker volume inspect returned invalid JSON: {name}") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise CodegenError(f"Docker volume inspect is ambiguous: {name}")
    document = value[0]
    try:
        validate_local_named_volume(document, name)
    except DockerNamedVolumeSafetyError as error:
        raise CodegenError(f"Docker named volume has unsafe backing: {name}: {error}") from error
    descriptor = _canonical_json(document)
    if len(descriptor) > 256 * 1024:
        raise CodegenError(f"Docker volume inspect descriptor is too large: {name}")
    return document


def _inspect_technical_volumes(
    project: str,
    backend: Mapping[str, Any],
    frontend: Mapping[str, Any],
    control_namespace: str | None = None,
) -> dict[str, Any]:
    from bootstrap_docker_toolchain import control_volume_name

    backend_namespace = _backend_control_namespace(backend)
    if control_namespace is None:
        control_namespace = backend_namespace
    else:
        control_namespace = _control_namespace(control_namespace)
        if control_namespace != backend_namespace:
            raise CodegenError("backend control namespace differs from the selected codegen namespace")

    services = (("backend", backend, ("/build", "/opt/fullmag/package", "/opt/fullmag/control")),
                ("frontend", frontend, ("/state/development", "/opt/fullmag/control")))
    volume_documents: dict[str, dict[str, Any]] = {}
    mount_descriptors: dict[str, dict[str, dict[str, str]]] = {}
    control_names: dict[str, str] = {}
    for service, document, targets in services:
        service_mounts: dict[str, dict[str, str]] = {}
        for target in targets:
            mount = _mount_for(document, target)
            name = _volume_name(mount, service, target)
            if name not in volume_documents:
                volume_documents[name] = _inspect_named_volume(name)
            descriptor = volume_documents[name]
            subpath = _mount_subpath(document, mount, target)
            if target == "/opt/fullmag/control":
                relative = "" if service == "backend" else "frontend"
                expected_subpath = _control_subpath(control_namespace, relative)
                subpath = _validate_control_mount_subpath(
                    document, mount, target, descriptor, expected_subpath
                )
            service_mounts[target] = {"name": name, "subpath": subpath or ""}
            if target == "/opt/fullmag/control":
                control_names[service] = name
        mount_descriptors[service] = service_mounts
    expected_control = control_volume_name(project)
    if (control_names.get("backend") != expected_control
            or control_names.get("frontend") != expected_control):
        raise CodegenError("backend and frontend do not share the selected Compose-group control volume")
    return {
        "control_volume_name": expected_control,
        "mounts": mount_descriptors,
        "volumes": volume_documents,
    }


def _read_json_bytes(raw: bytes, label: str, limit: int = MAX_RECEIPT_BYTES) -> dict[str, Any]:
    if not raw or len(raw) > limit:
        raise CodegenError(f"{label} exceeds its size bound")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise CodegenError(f"{label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise CodegenError(f"{label} must be a JSON object")
    return value


def _backend_documents(container: str) -> tuple[dict[str, Any], dict[str, Any], str, str]:
    stdout, _ = _exec(container, ("/usr/local/bin/python3", "-c", BACKEND_DOCUMENTS_SCRIPT),
                      timeout=120, stdout_limit=MAX_RECEIPT_BYTES * 3)
    observed = _read_json_bytes(stdout, "backend provenance probe")
    receipt_record = observed.get("receipt")
    provenance_record = observed.get("provenance")
    if not isinstance(receipt_record, Mapping) or not isinstance(provenance_record, Mapping):
        raise CodegenError("backend provenance probe omitted receipt or provenance")
    receipt = receipt_record.get("value")
    provenance = provenance_record.get("value")
    receipt_sha = receipt_record.get("sha256")
    provenance_sha = provenance_record.get("sha256")
    binary_sha = observed.get("api_binary_sha256")
    if not isinstance(receipt, dict) or not isinstance(provenance, dict):
        raise CodegenError("backend provenance probe returned invalid documents")
    if not isinstance(receipt_sha, str) or not SHA256_RE.fullmatch(receipt_sha):
        raise CodegenError("backend receipt digest is invalid")
    if not isinstance(provenance_sha, str) or not SHA256_RE.fullmatch(provenance_sha):
        raise CodegenError("backend provenance digest is invalid")
    if not isinstance(binary_sha, str) or not SHA256_RE.fullmatch(binary_sha):
        raise CodegenError("fullmag-api binary digest is invalid")
    return receipt, provenance, receipt_sha, f"{provenance_sha}:{binary_sha}"


def _validate_backend(receipt: Mapping[str, Any], provenance: Mapping[str, Any],
                      receipt_sha: str, provenance_and_binary: str) -> tuple[dict[str, Any], str, str]:
    if receipt.get("schema") != "fullmag.direct-compose.backend-build-receipt.v1" or receipt.get("state") != "succeeded":
        raise CodegenError("backend has no successful direct-Compose build receipt")
    if provenance.get("schema") != "fullmag.docker-all-image.v1" or provenance.get("state") != "succeeded":
        raise CodegenError("backend has no successful runtime provenance")
    if provenance.get("build_receipt_sha256") != receipt_sha:
        raise CodegenError("backend runtime provenance is not bound to its build receipt")
    source = receipt.get("source")
    native = receipt.get("native_source_identity")
    if not isinstance(source, dict) or not isinstance(native, dict):
        raise CodegenError("backend receipt has incomplete source identity")
    commit = source.get("resolved_commit")
    snapshot = native.get("source_snapshot_sha256")
    source_digest = source.get("source_digest")
    if not isinstance(commit, str) or not COMMIT_RE.fullmatch(commit):
        raise CodegenError("backend receipt has no full source commit")
    if not isinstance(snapshot, str) or not SHA256_RE.fullmatch(snapshot):
        raise CodegenError("backend receipt has no source snapshot digest")
    if not isinstance(source_digest, str) or not SHA256_RE.fullmatch(source_digest):
        raise CodegenError("backend receipt has no source digest")
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list):
        raise CodegenError("backend receipt has no artifact list")
    artifact = next((item for item in artifacts if isinstance(item, Mapping) and item.get("path") == "bin/fullmag-api"), None)
    if not isinstance(artifact, Mapping) or not isinstance(artifact.get("sha256"), str) or not SHA256_RE.fullmatch(artifact["sha256"]):
        raise CodegenError("backend receipt has no fullmag-api artifact hash")
    provenance_binary = provenance.get("binary_hashes")
    if not isinstance(provenance_binary, Mapping):
        raise CodegenError("backend provenance has no binary hashes")
    provenance_sha, binary_sha = provenance_and_binary.split(":", 1)
    if artifact.get("sha256") != binary_sha or provenance_binary.get("fullmag-api") != binary_sha:
        raise CodegenError("fullmag-api hash is not bound to the backend receipt")
    return {
        "commit": commit,
        "snapshot": snapshot,
        "source_digest": source_digest,
        "native": native,
        "worktree_state": "dirty" if native.get("source_snapshot_dirty") is True else "clean",
    }, provenance_sha, binary_sha


def _probe_source(container: str, token: str) -> tuple[dict[str, Any], str]:
    stdout, _ = _exec(container, ("/usr/local/bin/python3", "-c", SOURCE_PROBE_SCRIPT, token),
                      timeout=600, stdout_limit=MAX_OPENAPI_BYTES, stderr_limit=MAX_TOOL_OUTPUT_BYTES)
    document = _read_json_bytes(stdout, "live source identity probe", MAX_OPENAPI_BYTES)
    if document.get("schema") != "fullmag.docker-backend-live-source.v1":
        raise CodegenError("live source probe returned an unsupported schema")
    if not isinstance(document.get("native_source_identity"), dict):
        raise CodegenError("live source probe has no native source identity")
    return document, _sha256(stdout)


def _source_matches(probe: Mapping[str, Any], backend: Mapping[str, Any]) -> bool:
    native = probe.get("native_source_identity")
    return isinstance(native, Mapping) and (
        probe.get("resolved_commit") == backend["commit"]
        and probe.get("source_digest") == backend["source_digest"]
        and probe.get("source_snapshot_sha256") == backend["snapshot"]
        and dict(native) == backend["native"]
    )


def _frontend_source_digest(source: Path) -> tuple[str, dict[str, str]]:
    relatives = (
        "apps/control-room/scripts/generate-openapi-v2.mjs",
        "apps/control-room/scripts/generate-v2-client.mjs",
        "apps/control-room/scripts/normalize-openapi-build-identity.mjs",
        "apps/control-room/package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
    )
    files: dict[str, str] = {}
    for relative in relatives:
        path = source / relative
        try:
            metadata = path.lstat()
        except OSError as error:
            raise CodegenError(f"frontend codegen input is unavailable: {relative}") from error
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > MAX_GENERATED_BYTES:
            raise CodegenError(f"frontend codegen input is not a bounded regular file: {relative}")
        files[relative] = _sha256(path.read_bytes())
    return _sha256(_canonical_json(files)), files


def _stage_file(frontend: str, stage: str, name: str, data: bytes) -> None:
    path = f"/state/development/codegen/{stage}/{name}"
    _exec(frontend, ("/usr/local/bin/python3", "-c", ATOMIC_WRITE_SCRIPT, path),
          timeout=120, input_bytes=data, stdout_limit=64 * 1024)


def _stage_path(stage: str, name: str) -> str:
    return f"/state/development/codegen/{stage}/{name}"


def _run_frontend(frontend: str, arguments: Sequence[str], *, timeout: int = 600,
                  stdout_limit: int = MAX_TOOL_OUTPUT_BYTES) -> tuple[bytes, bytes]:
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/state/development",
        "PNPM_HOME": "/state/development/pnpm-home",
        "npm_config_store_dir": "/state/development/pnpm-store",
        "COREPACK_ENABLE_PROJECT_SPEC": "1",
        "COREPACK_DEFAULT_TO_LATEST": "0",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
        "TMPDIR": "/tmp",
    }
    return _exec(frontend, arguments, timeout=timeout, stdout_limit=stdout_limit,
                 stderr_limit=MAX_TOOL_OUTPUT_BYTES, workdir="/state/development/workspace",
                 environment=environment)


def _read_stage(frontend: str, stage: str, name: str, limit: int) -> bytes:
    stdout, _ = _exec(frontend, ("/bin/cat", _stage_path(stage, name)), timeout=120,
                      stdout_limit=limit)
    if not stdout:
        raise CodegenError(f"frontend generator produced an empty {name}")
    return stdout


def _cleanup_stage(frontend: str, stage: str) -> None:
    _exec(frontend, ("/usr/local/bin/python3", "-c", CLEANUP_SCRIPT, stage), timeout=120,
          stdout_limit=64 * 1024)


def _output_baseline(source: Path, names: Sequence[str]) -> dict[str, str | None]:
    target_root = source / "apps/control-room/src/kernel/api/generated"
    if target_root.is_symlink() or not target_root.is_dir():
        raise CodegenError("generated frontend directory is not a real directory")
    baseline: dict[str, str | None] = {}
    for name in names:
        path = target_root / name
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise CodegenError(f"generated output is unsafe: {name}")
        baseline[name] = _sha256(path.read_bytes()) if path.exists() else None
    return baseline


def _publish_outputs(source: Path, outputs: Mapping[str, bytes], before: Mapping[str, str | None]) -> dict[str, str]:
    target_root = source / "apps/control-room/src/kernel/api/generated"
    current: dict[str, str | None] = {}
    for name in outputs:
        path = target_root / name
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise CodegenError(f"generated output is unsafe: {name}")
        current[name] = _sha256(path.read_bytes()) if path.exists() else None
    if current != dict(before):
        raise CodegenError("generated source files changed while codegen was running")
    temporary: list[tuple[Path, Path]] = []
    try:
        for name, data in outputs.items():
            destination = target_root / name
            handle, temporary_name = tempfile.mkstemp(prefix=f".{name}.", dir=target_root)
            temporary.append((Path(temporary_name), destination))
            with os.fdopen(handle, "wb", closefd=True) as stream:
                stream.write(data)
                stream.flush()
                # Tracked public sources must also be readable by the frontend UID.
                os.chmod(temporary_name, 0o644)
                os.fsync(stream.fileno())
        published: dict[str, str] = {}
        for temporary_name, destination in temporary:
            os.replace(temporary_name, destination)
            if destination.is_symlink() or not destination.is_file():
                raise CodegenError(f"published output is not a regular file: {destination.name}")
            observed = _sha256(destination.read_bytes())
            expected = _sha256(outputs[destination.name])
            if observed != expected:
                raise CodegenError(f"published output hash mismatch: {destination.name}")
            published[destination.name] = observed
        return published
    finally:
        for temporary_name, _destination in temporary:
            try:
                temporary_name.unlink()
            except FileNotFoundError:
                pass


def _write_receipt(backend: str, path: str, receipt: Mapping[str, Any]) -> None:
    _exec(backend, ("/usr/local/bin/python3", "-c", ATOMIC_CONTROL_WRITE_SCRIPT, path),
          timeout=120, input_bytes=_canonical_json(receipt), stdout_limit=64 * 1024)


def _select_checkout(repo: Path, source_root: Path | None) -> tuple[Path, dict[str, str]]:
    from docker_compose_identity import compose_project_identity
    from docker_development_inputs import select_checkout
    from fullmag_storage import resolve_layout

    selected = select_checkout(repo, source_root).resolve(strict=True)
    if selected.is_symlink() or not selected.is_dir():
        raise CodegenError(f"selected source is not a real checkout: {selected}")
    layout = resolve_layout(selected, "docker-all-gpu")
    return selected, compose_project_identity(layout)


def _build_proof(project: str, backend_id: str, frontend_id: str,
                 source_probe: Mapping[str, Any], backend: Mapping[str, Any],
                 receipt_sha: str, provenance_sha: str, binary_sha: str,
                 raw: bytes, stderr: bytes) -> dict[str, Any]:
    native = backend["native"]
    return {
        "schema": DIRECT_CODEGEN_SCHEMA,
        "state": "succeeded",
        "exit_code": 0,
        "compose_project": project,
        "backend_container_id": backend_id,
        "frontend_container_id": frontend_id,
        "source_commit": backend["commit"],
        "source_snapshot_sha256": backend["snapshot"],
        "source_digest": backend["source_digest"],
        "source_identity": {
            "git_commit": backend["commit"],
            "source_snapshot_sha256": backend["snapshot"],
            "source_digest": backend["source_digest"],
            "worktree_state": backend["worktree_state"],
            "native_source_identity_sha256": _sha256(_canonical_json(native)),
        },
        "backend_build_receipt_sha256": receipt_sha,
        "backend_provenance_sha256": provenance_sha,
        "api_binary_sha256": binary_sha,
        "raw_openapi_sha256": _sha256(raw),
        "raw_openapi_bytes": len(raw),
        "stderr_sha256": _sha256(stderr),
        "stderr_bytes": len(stderr),
        "source_probe_live_manifest_sha256": source_probe.get("live_manifest_sha256"),
    }


def run(repo_root: Path, source_root: Path | None) -> int:
    started = time.monotonic()
    selected, identity = _select_checkout(repo_root, source_root)
    project = identity["project_name"]
    backend_id: str | None = None
    frontend_id: str | None = None
    stage: str | None = None
    stage_ready = False
    cleanup_attempted = False
    cleanup_state = "not_started"
    phase = "service-selection"
    service_identities: dict[str, dict[str, str]] = {}
    published: dict[str, str] | None = None
    try:
        backend_id, backend_document = _running_service(project, "backend", identity, selected)
        control_namespace = _backend_control_namespace(backend_document)
        frontend_id, frontend_document = _running_service(
            project, "frontend", identity, selected, control_namespace
        )
        service_identities = {
            "backend": _service_identity(backend_id, backend_document),
            "frontend": _service_identity(frontend_id, frontend_document),
        }
        phase = "technical-volume-inspection"
        technical_volumes_before = _inspect_technical_volumes(
            project, backend_document, frontend_document, control_namespace
        )
        frontend_input_digest, frontend_inputs = _frontend_source_digest(selected)
        output_names = ("openapi-v2.json", "openapi-v2-types.ts", "openapi-v2-client.ts", "openapi-v2-paths.ts")
        baseline = _output_baseline(selected, output_names)
        stage = hashlib.sha256(f"{project}:{backend_id}:{frontend_id}:{time.time_ns()}".encode()).hexdigest()
        # The stage id is intentionally ephemeral and is always cleaned after
        # generation.  It must not enter the durable deterministic receipt key.
        cleanup_state = "pending"
        phase = "source-probe-before"
        probe_before, _ = _probe_source(backend_id, stage[:32])
        phase = "backend-provenance"
        receipt, provenance, receipt_sha, provenance_and_binary = _backend_documents(backend_id)
        backend, provenance_sha, binary_sha = _validate_backend(receipt, provenance, receipt_sha, provenance_and_binary)
        if not _source_matches(probe_before, backend):
            raise CodegenError("backend package is stale relative to the mounted source")
        phase = "openapi-export"
        raw, api_stderr = _exec(backend_id, ("/opt/fullmag/package/bin/fullmag-api", "--print-openapi-v2"),
                                timeout=180, stdout_limit=MAX_OPENAPI_BYTES, stderr_limit=MAX_TOOL_OUTPUT_BYTES)
        document = _read_json_bytes(raw, "backend OpenAPI export", MAX_OPENAPI_BYTES)
        raw_identity = document.get("x-fullmag-build-identity")
        if not isinstance(raw_identity, Mapping) or raw_identity.get("git_commit") != backend["commit"] or raw_identity.get("source_snapshot_sha256") != backend["snapshot"]:
            raise CodegenError("backend OpenAPI export identity differs from its receipt")
        proof = _build_proof(project, backend_id, frontend_id, probe_before, backend,
                             receipt_sha, provenance_sha, binary_sha, raw, api_stderr)
        stage_ready = True
        phase = "stage-backend-output"
        _stage_file(frontend_id, stage, "stdout.raw.json", raw)
        _stage_file(frontend_id, stage, "codegen-proof.json", _canonical_json(proof))
        node = "/usr/local/bin/node"
        generate_openapi = "/state/development/workspace/apps/control-room/scripts/generate-openapi-v2.mjs"
        generate_client = "/state/development/workspace/apps/control-room/scripts/generate-v2-client.mjs"
        phase = "frontend-tool-versions"
        node_version_raw, _ = _run_frontend(frontend_id, (node, "--version"), timeout=60, stdout_limit=64 * 1024)
        pnpm_version_raw, _ = _run_frontend(frontend_id, ("/usr/local/bin/pnpm", "--version"), timeout=60, stdout_limit=64 * 1024)
        openapi_tool_version_raw, _ = _run_frontend(
            frontend_id,
            ("/usr/local/bin/pnpm", "--dir", "/state/development/workspace/apps/control-room",
             "exec", "openapi-typescript", "--version"),
            timeout=120,
            stdout_limit=64 * 1024,
        )
        node_version = node_version_raw.decode("utf-8", "replace").strip().splitlines()[-1]
        pnpm_version = pnpm_version_raw.decode("utf-8", "replace").strip().splitlines()[-1]
        openapi_tool_version = openapi_tool_version_raw.decode("utf-8", "replace").strip().splitlines()[-1]
        if not node_version or not pnpm_version or not openapi_tool_version:
            raise CodegenError("frontend codegen tool version probe returned an empty value")
        normalized = _stage_path(stage, "openapi-v2.json")
        phase = "frontend-codegen"
        _run_frontend(frontend_id, (node, generate_openapi, "--input", _stage_path(stage, "stdout.raw.json"),
                                    "--output", normalized, "--expected-commit", backend["commit"],
                                    "--expected-snapshot", backend["snapshot"], "--expected-source-digest",
                                    backend["source_digest"], "--direct-compose-receipt", _stage_path(stage, "codegen-proof.json")),
                      timeout=180)
        _run_frontend(frontend_id, (node, generate_client, "--input", normalized, "--output-dir",
                                    f"/state/development/codegen/{stage}"), timeout=180)
        type_output = _stage_path(stage, "openapi-v2-types.ts")
        _run_frontend(frontend_id, ("/usr/local/bin/pnpm", "--dir", "/state/development/workspace/apps/control-room",
                                    "exec", "openapi-typescript", normalized, "--output", type_output,
                                    "--empty-objects-unknown"), timeout=600)
        normalized_bytes = _read_stage(frontend_id, stage, "openapi-v2.json", MAX_OPENAPI_BYTES)
        types_bytes = _read_stage(frontend_id, stage, "openapi-v2-types.ts", MAX_GENERATED_BYTES)
        client_bytes = _read_stage(frontend_id, stage, "openapi-v2-client.ts", MAX_GENERATED_BYTES)
        paths_bytes = _read_stage(frontend_id, stage, "openapi-v2-paths.ts", MAX_GENERATED_BYTES)
        normalized_document = _read_json_bytes(normalized_bytes, "normalized OpenAPI", MAX_OPENAPI_BYTES)
        normalized_identity = normalized_document.get("x-fullmag-build-identity")
        if not isinstance(normalized_identity, Mapping) or normalized_identity.get("git_commit") != "generated-artifact":
            raise CodegenError("normalized OpenAPI identity was not canonicalized")
        phase = "source-probe-after"
        probe_after, _ = _probe_source(backend_id, hashlib.sha256((stage + "-after").encode()).hexdigest()[:32])
        frontend_after_digest, frontend_after = _frontend_source_digest(selected)
        if not _source_matches(probe_after, backend) or frontend_after_digest != frontend_input_digest or frontend_after != frontend_inputs:
            raise CodegenError("source identity changed during OpenAPI codegen")
        outputs = {
            "openapi-v2.json": normalized_bytes,
            "openapi-v2-types.ts": types_bytes,
            "openapi-v2-client.ts": client_bytes,
            "openapi-v2-paths.ts": paths_bytes,
        }
        phase = "staging-cleanup"
        cleanup_attempted = True
        _cleanup_stage(frontend_id, stage)
        stage_ready = False
        cleanup_state = "confirmed"
        phase = "final-service-and-volume-revalidation"
        backend_after_id, backend_after_document = _running_service(
            project, "backend", identity, selected, control_namespace
        )
        frontend_after_id, frontend_after_document = _running_service(
            project, "frontend", identity, selected, control_namespace
        )
        final_service_identities = {
            "backend": _service_identity(backend_after_id, backend_after_document),
            "frontend": _service_identity(frontend_after_id, frontend_after_document),
        }
        if final_service_identities != service_identities:
            raise CodegenError("service or image identity changed before publication")
        technical_volumes_after = _inspect_technical_volumes(
            project, backend_after_document, frontend_after_document, control_namespace
        )
        if technical_volumes_after != technical_volumes_before:
            raise CodegenError("technical volume identity changed before publication")
        phase = "source-publication"
        published = _publish_outputs(selected, outputs, baseline)
        tool_versions = {
            "node": node_version,
            "pnpm": pnpm_version,
            "openapi-typescript": openapi_tool_version,
        }
        receipt_key = _codegen_receipt_key(
            proof["source_identity"], proof["raw_openapi_sha256"], frontend_input_digest, tool_versions
        )
        receipt_path = f"/opt/fullmag/control/backend/codegen/openapi-v2/{receipt_key}.json"
        receipt_document = {
            **proof,
            "receipt_key": receipt_key,
            "generated": {name: {"sha256": _sha256(data), "bytes": len(data)} for name, data in outputs.items()},
            "generated_output_snapshot_sha256": _output_snapshot_sha256(outputs),
            "published": published,
            "input_source_identity": proof["source_identity"],
            "frontend_codegen_inputs_sha256": frontend_input_digest,
            "frontend_codegen_inputs": frontend_inputs,
            "frontend_tool_versions": tool_versions,
            "services": {"before": service_identities, "after": final_service_identities},
            "technical_volume_inspections": {
                "before": technical_volumes_before,
                "after": technical_volumes_after,
            },
            "staging": {
                "volume_path": f"/state/development/codegen/{stage}",
                "stage_id": stage,
                "ephemeral": True,
                "cleanup_confirmed": True,
            },
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
        _write_receipt(backend_id, receipt_path, receipt_document)
        print(json.dumps({"schema": DIRECT_CODEGEN_SCHEMA, "state": "succeeded", "receipt": receipt_path,
                          "compose_project": project, "published": published}, sort_keys=True))
        return 0
    except Exception as error:
        if stage_ready and stage and frontend_id:
            if getattr(error, "reconciliation_required", False):
                cleanup_state = "unknown"
            elif not cleanup_attempted:
                cleanup_attempted = True
                try:
                    _cleanup_stage(frontend_id, stage)
                    stage_ready = False
                    cleanup_state = "confirmed"
                except Exception as cleanup_error:  # noqa: BLE001 - preserve original failure
                    cleanup_state = "unknown" if getattr(cleanup_error, "reconciliation_required", False) else "failed"
                    print(f"docker-dev-codegen: staging cleanup failed: {cleanup_error}", file=sys.stderr)
            else:
                cleanup_state = "unknown" if getattr(error, "reconciliation_required", False) else "failed"
        if backend_id:
            failure = _failure_receipt_document(
                project=project,
                phase=phase,
                error=error,
                backend_id=backend_id,
                frontend_id=frontend_id,
                stage=stage,
                cleanup_state=cleanup_state,
                started=started,
                service_identities=service_identities,
                published=published,
            )
            try:
                _write_receipt(backend_id, FAILURE_RECEIPT_PATH, failure)
            except Exception as receipt_error:  # noqa: BLE001 - preserve original failure
                print(f"docker-dev-codegen: failure receipt write failed: {receipt_error}", file=sys.stderr)
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        return run(args.repo_root.resolve(strict=True), args.source_root)
    except (CodegenError, OSError, ValueError, RuntimeError) as error:
        print(f"docker-dev-codegen: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
