"""Retained forensic startup probe for one failed managed FEM runtime job.

The probe is diagnostic_only and never qualifies a runtime. It accepts no
caller-supplied command, does not restart the failed worker, and retains the
new diagnostic container and output for later operator cleanup.
"""
from __future__ import annotations

import argparse
from contextlib import suppress
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import uuid
from typing import Any, Callable, Mapping, Sequence

from fullmag_storage import (
    StorageError,
    atomic_json,
    build_lock,
    initialize,
    is_link,
    resolve_layout,
    validate_path,
)
from local_runner.coordinator import CoordinatorError, docker
from local_runner.queue import JobQueue

DIAGNOSTIC_SCHEMA = "fullmag.fem.startup-diagnostic.v1"
JOB_ID_RE = re.compile(r"[a-f0-9]{32}\Z")
DIGEST_RE = re.compile(r"[a-f0-9]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[a-f0-9]{64}\Z")
CONTAINER_RE = re.compile(r"[a-f0-9]{64}\Z")
CAPTURE_RE = re.compile(r"[a-f0-9]{32}\Z")
SLEPC_PROFILES = frozenset(
    {"fem-cpu-slepc-runtime-v1", "fem-cpu-slepc-runtime-v2"}
)
AVAILABILITY_ERROR = re.compile(
    r"^BuildEntryPointError: SLEPc runtime availability probe "
    r"(?:failed|timed out|unavailable|exited|returned|did not attest|startup stamp)"
)
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_CAPTURE_BYTES = 128 * 1024
PROBE_TIMEOUT_SECONDS = 10
TERM_GRACE_SECONDS = 2
MEMORY_BYTES = 1024**3
PIDS_LIMIT = 128
RUNTIME_BINARY = "/workspace/.fullmag/local/bin/fullmag-bin"
DRIVER_TARGET = "/diagnostic-driver.py"
OUTPUT_TARGET = "/diagnostic-output"
TMPFS = "/tmp:rw,nosuid,nodev,noexec,size=64m"
SUPERVISOR = "while :; do sleep 3600; done"
CONTAINER_PATH = "/bin/sh"
CONTAINER_ARGS = ("-c", SUPERVISOR)
LINKAGE_SCRIPT = (
    "set +e; "
    "for target in "
    "/workspace/.fullmag/local/bin/fullmag-bin "
    "/workspace/.fullmag/local/lib/libfullmag_fem.so.0.1.0; do "
    "if command -v ldd >/dev/null 2>&1; then "
    "echo '[fullmag forensic] ldd' \"$target\"; "
    "ldd \"$target\"; "
    "else echo '[fullmag forensic] ldd unavailable'; fi; "
    "if command -v readelf >/dev/null 2>&1; then "
    "echo '[fullmag forensic] readelf' \"$target\"; "
    "readelf -d \"$target\"; "
    "else echo '[fullmag forensic] readelf unavailable'; fi; "
    "done"
)
PROBES = (
    ("fullmag-help", (RUNTIME_BINARY, "--help")),
    ("fullmag-help-loader", ("/usr/bin/env", "LD_DEBUG=libs", RUNTIME_BINARY, "--help")),
    ("fem-availability", (RUNTIME_BINARY, "runtime", "fem-availability", "--json")),
    ("loader-linkage", ("/bin/sh", "-c", LINKAGE_SCRIPT)),
)


class DiagnosticError(RuntimeError):
    """Fail-closed forensic precondition or retained-container error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def bounded_text(value: object, limit: int = 4096) -> str:
    if isinstance(value, bytes):
        return value[:limit].decode("utf-8", errors="replace")
    return str(value)[:limit]


def _json(path: Path, root: Path, label: str) -> dict[str, Any]:
    path = validate_path(path, root, label)
    if is_link(path) or not path.is_file():
        raise DiagnosticError(f"{label} must be a regular file: {path}")
    if path.stat().st_size > MAX_JSON_BYTES:
        raise DiagnosticError(f"{label} exceeds the JSON bound")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise DiagnosticError(f"cannot read {label}: {path}") from error
    if not isinstance(value, dict):
        raise DiagnosticError(f"{label} must be an object")
    return value


def _file(path: Path, root: Path, label: str) -> Path:
    path = validate_path(path, root, label)
    if is_link(path) or not path.is_file():
        raise DiagnosticError(f"{label} must be a regular file: {path}")
    return path


def _directory(path: Path, root: Path, label: str) -> Path:
    path = validate_path(path, root, label)
    if is_link(path) or not path.is_dir():
        raise DiagnosticError(f"{label} must be a regular directory: {path}")
    return path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _identity(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != "fullmag.source-snapshot.v2":
        raise DiagnosticError(f"{label} is not source-snapshot.v2")
    commit = value.get("head_commit_full")
    if not isinstance(commit, str) or not re.fullmatch(
        r"[a-f0-9]{40}(?:[a-f0-9]{24})?\Z", commit
    ):
        raise DiagnosticError(f"{label}.head_commit_full is invalid")
    for key in ("source_snapshot_sha256", "dirty_content_sha256"):
        if not isinstance(value.get(key), str) or not DIGEST_RE.fullmatch(value[key]):
            raise DiagnosticError(f"{label}.{key} is invalid")
    return value


def _same(values: Sequence[object], label: str) -> object:
    if not values or any(value != values[0] for value in values[1:]):
        raise DiagnosticError(f"{label} differs between trusted records")
    return values[0]


def is_availability_probe_error(value: object) -> bool:
    return isinstance(value, str) and bool(AVAILABILITY_ERROR.match(value))


def _load_job(layout: Mapping[str, Any], job_id: str) -> dict[str, Any]:
    if not JOB_ID_RE.fullmatch(job_id):
        raise DiagnosticError("job id must be 32 lowercase hexadecimal characters")
    storage = Path(str(layout["storage_root"])).resolve()
    queue_path = validate_path(
        storage / "index" / "runner-jobs.sqlite", storage, "runner queue"
    )
    try:
        job = JobQueue(queue_path, readonly=True).get(job_id)
    except Exception as error:
        raise DiagnosticError(f"cannot read managed queue: {error}") from error
    if not isinstance(job, dict):
        raise DiagnosticError(f"unknown managed job: {job_id}")
    if job.get("state") != "failed" or job.get("operation") != "build":
        raise DiagnosticError("only terminal failed build jobs are accepted")
    if job.get("worktree_id") != layout["worktree_id"]:
        raise DiagnosticError("job belongs to another resolved worktree")
    if job.get("profile") not in SLEPC_PROFILES:
        raise DiagnosticError("job is not a CPU/SLEPc runtime profile")
    if type(job.get("exit_code")) is not int or job["exit_code"] == 0:
        raise DiagnosticError("job has no nonzero terminal exit code")
    payload = job.get("payload")
    source_digest = job.get("source_digest")
    if not isinstance(payload, dict) or not isinstance(source_digest, str) or not DIGEST_RE.fullmatch(source_digest):
        raise DiagnosticError("job payload/source identity is invalid")
    capture_id = payload.get("capture_id")
    expected_capsule = f"runs/{job['worktree_id']}/{capture_id}/source"
    if not isinstance(capture_id, str) or not CAPTURE_RE.fullmatch(capture_id):
        raise DiagnosticError("capture identity is invalid")
    if payload.get("capsule_relative") != expected_capsule:
        raise DiagnosticError("capsule path is not canonical")
    native_identity = _identity(payload.get("native_source_identity"), "job native identity")
    run_root = _directory(storage / "runs" / job["worktree_id"] / job_id, storage, "failed job root")
    execution = _directory(run_root / "execution", storage, "failed execution")
    paths = {
        "coordinator": _file(run_root / "coordinator.json", storage, "coordinator journal"),
        "receipt": _file(run_root / "receipt.json", storage, "terminal receipt"),
        "build_receipt": _file(run_root / "artifacts" / "build-receipt.json", storage, "build receipt"),
        "context": _file(run_root / "trusted" / "context.json", storage, "trusted context"),
    }
    records = {key: _json(path, storage, key) for key, path in paths.items()}
    for label, record in records.items():
        if record.get("job_id") != job_id or record.get("source_digest") != source_digest:
            raise DiagnosticError(f"{label} identity mismatch")
    coordinator = records["coordinator"]
    if (
        coordinator.get("schema") != "fullmag.local-runner.coordinator.v1"
        or coordinator.get("phase") != "terminal"
        or coordinator.get("state") != "failed"
        or coordinator.get("exit_code") != job["exit_code"]
    ):
        raise DiagnosticError("coordinator record is not terminal failed")
    container_id = coordinator.get("container_id")
    if not isinstance(container_id, str) or not CONTAINER_RE.fullmatch(container_id):
        raise DiagnosticError("failed job has no retained full container ID")
    image = _same(
        [coordinator.get("image_digest"), records["receipt"].get("image_digest"),
         records["build_receipt"].get("image_digest"), records["context"].get("image_digest")],
        "image identity",
    )
    if not isinstance(image, str) or not IMAGE_RE.fullmatch(image):
        raise DiagnosticError("trusted image identity is invalid")
    identities = [
        native_identity,
        _identity(records["context"].get("native_source_identity"), "context native identity"),

        _identity(records["build_receipt"].get("native_source_identity"), "build native identity"),
    ]
    if any(value != identities[0] for value in identities[1:]):
        raise DiagnosticError("native source identity differs between records")
    context = records["context"]
    receipt = records["receipt"]
    build_receipt = records["build_receipt"]
    if (
        receipt.get("schema") != "fullmag.local-runner.coordinator.v1"
        or receipt.get("profile") != job["profile"]
        or receipt.get("operation") != "build"
        or receipt.get("phase") != "terminal"
        or receipt.get("state") != "failed"
        or receipt.get("exit_code") != job["exit_code"]
        or receipt.get("qualification") != "NOT VERIFIED"
        or receipt.get("container_id") != container_id
        or receipt.get("mounts") != coordinator.get("mounts")
        or receipt.get("trusted_hashes") != coordinator.get("trusted_hashes")
    ):
        raise DiagnosticError("terminal receipt bindings are not trusted")
    trusted_hashes = receipt.get("trusted_hashes")
    if not isinstance(trusted_hashes, dict):
        raise DiagnosticError("terminal receipt has no trusted hashes")
    for key, value in trusted_hashes.items():
        if (
            not isinstance(key, str)
            or not isinstance(value, str)
            or not DIGEST_RE.fullmatch(value)
        ):
            raise DiagnosticError("terminal receipt trusted hash is invalid")
    for required in ("build_entrypoint.py", "worker_entrypoint.py", "context.json"):
        if required not in trusted_hashes:
            raise DiagnosticError(f"terminal receipt is missing {required} hash")
    if trusted_hashes["context.json"] != _sha256(paths["context"]):
        raise DiagnosticError("terminal receipt context hash differs")
    if (
        context.get("profile") != job["profile"]
        or build_receipt.get("profile") != job["profile"]
        or build_receipt.get("schema") != "fullmag.local-runner.build-receipt.v1"
        or build_receipt.get("state") != "failed"
        or build_receipt.get("qualification") != "NOT VERIFIED"
        or build_receipt.get("runtime_only") is not True
    ):
        raise DiagnosticError("unqualified failed runtime receipt is not trusted")
    contract = build_receipt.get("runtime_contract")
    if (
        not isinstance(contract, dict)
        or contract.get("schema") != "fullmag.fem.cpu.slepc_runtime_contract.v2"
        or contract.get("backend") != "fem"
        or contract.get("device") != "cpu"
        or contract.get("precision") != "double"
        or contract.get("slepc") is not True
        or contract.get("unit_test_targets") != []
    ):
        raise DiagnosticError("runtime contract is not CPU/SLEPc")
    stages = build_receipt.get("stages")
    native_stages = [
        stage for stage in stages or ()
        if isinstance(stage, dict) and stage.get("name") == "native-build"
    ]
    if len(native_stages) != 1 or native_stages[0].get("exit_code") != 0:
        raise DiagnosticError("native-build did not exit zero")
    if not is_availability_probe_error(build_receipt.get("error")):
        raise DiagnosticError("terminal error is not an availability-probe error")
    mounts = coordinator.get("mounts")
    if not isinstance(mounts, list) or not any(
        isinstance(mount, list) and len(mount) >= 4
        and mount[0] == "bind" and mount[2] == "/workspace" and mount[3] is True
        for mount in mounts
    ):
        raise DiagnosticError("failed execution mount is not attested")
    capsule = _directory(storage / payload["capsule_relative"], storage, "source capsule")
    binary = _file(
        execution / ".fullmag" / "local" / "bin" / "fullmag-bin",
        execution,
        "failed fullmag-bin",
    )
    return {
        "job": job,
        "storage": storage,
        "run_root": run_root,
        "execution": execution,
        "capsule": capsule,
        "binary": binary,
        "paths": paths,
        "records": records,
        "container_id": container_id,
        "image": image,
        "native_identity": native_identity,
        "contract": contract,
    }


def _image_info(call: Callable[[list[str]], str], image: str) -> str:
    try:
        records = json.loads(call(["image", "inspect", image]))
    except (CoordinatorError, OSError, json.JSONDecodeError) as error:
        raise DiagnosticError(f"cannot inspect diagnostic image: {error}") from error
    if not isinstance(records, list) or len(records) != 1 or records[0].get("Id") != image:
        raise DiagnosticError("diagnostic image identity mismatch")
    config = records[0].get("Config")
    if not isinstance(config, dict):
        raise DiagnosticError("diagnostic image has no config")
    for item in config.get("Env") or ():
        if isinstance(item, str) and item.startswith("LD_LIBRARY_PATH="):
            value = item.split("=", 1)[1]
            if "\n" in value or "\r" in value:
                raise DiagnosticError("image LD_LIBRARY_PATH contains newline")
            return value
    return ""


def _library_path(image_path: str) -> str:
    values = [
        "/workspace/.fullmag/local/lib",
        "/opt/fullmag-mfem-cpu/lib",
        "/opt/fullmag-deps/lib",
        "/usr/local/cuda/compat",
        "/usr/local/cuda/lib64",
    ]
    values.extend(image_path.split(":") if image_path else ())
    return ":".join(dict.fromkeys(value for value in values if value))


def _diagnostic_environment(image_library_path: str) -> dict[str, str]:
    return {
        "HOME": "/tmp",
        "TMPDIR": "/tmp",
        "FULLMAG_FORCE_LOCAL_FEM_CPU": "1",
        "FULLMAG_FORCE_LOCAL_FEM_GPU": "0",
        "FULLMAG_FEM_REQUIRE_GPU": "0",
        "FULLMAG_FEM_REQUIRE_CEED": "0",
        "FULLMAG_FEM_WITH_SLEPC": "ON",
        "FULLMAG_USE_MFEM_STACK": "ON",
        "FULLMAG_MANAGED_FEM_DEVICE": "cpu",
        "FULLMAG_FEM_MFEM_DEVICE": "cpu",
        "FULLMAG_FEM_NATIVE_CUDA": "0",
        "FULLMAG_SKIP_MANAGED_FEM_GPU_EXPORT": "1",
        "CUDA_VISIBLE_DEVICES": "",
        "NVIDIA_VISIBLE_DEVICES": "void",
        "LD_LIBRARY_PATH": _library_path(image_library_path),
        "LD_DEBUG": "libs",
    }


def build_create_command(
    *, image: str, name: str, execution: Path, driver: Path, output: Path,
    image_library_path: str,
) -> list[str]:
    if not IMAGE_RE.fullmatch(image):
        raise DiagnosticError("image must be immutable")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,127}\Z", name):
        raise DiagnosticError("diagnostic container name is invalid")
    for path in (execution, driver, output):
        if not path.is_absolute() or any(char in str(path) for char in "\r\n,"):
            raise DiagnosticError("diagnostic mount path is invalid")
    command = [
        "create", "--init", "--name", name,
        "--label", "fullmag.diagnostic=managed-fem-startup-v1",
        "--label", "fullmag.diagnostic-source=terminal-failed-job",
        "--read-only", "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--user", "65532:65532",
        "--cpus", "1", "--memory", str(MEMORY_BYTES),
        "--memory-swap", str(MEMORY_BYTES), "--pids-limit", str(PIDS_LIMIT),
        "--tmpfs", TMPFS,
    ]
    for key, value in _diagnostic_environment(image_library_path).items():
        command.extend(("--env", f"{key}={value}"))
    command.extend([
        "--mount", f"type=bind,source={execution},target=/workspace,readonly",
        "--mount", f"type=bind,source={driver},target={DRIVER_TARGET},readonly",
        "--mount", f"type=bind,source={output},target={OUTPUT_TARGET}",
        "--workdir", "/workspace", "--entrypoint", CONTAINER_PATH, image,
        *CONTAINER_ARGS,
    ])
    return command


def _source_aliases(path: Path) -> set[str]:
    resolved = str(path.resolve())
    aliases = {os.path.normcase(os.path.normpath(resolved)).replace("\\", "/").rstrip("/")}
    drive, tail = os.path.splitdrive(resolved)
    if drive and len(drive) == 2 and tail:
        aliases.add(
            "/run/desktop/mnt/host/" + drive[0].lower() + "/"
            + tail.lstrip("\\/").replace("\\", "/").rstrip("/")
        )
    return aliases


def _source_matches(value: object, path: Path) -> bool:
    if not isinstance(value, str):
        return False
    observed = os.path.normcase(os.path.normpath(value)).replace("\\", "/").rstrip("/")
    return observed in _source_aliases(path)


def _validate_mounts(record: Mapping[str, Any], execution: Path, driver: Path, output: Path) -> None:
    mounts = record.get("Mounts")
    if not isinstance(mounts, list):
        raise DiagnosticError("diagnostic container has no mounts")
    expected = {
        "/workspace": (execution, False),
        DRIVER_TARGET: (driver, False),
        OUTPUT_TARGET: (output, True),
    }
    if len(mounts) != len(expected):
        raise DiagnosticError("diagnostic container mount count differs")
    observed: dict[str, Mapping[str, Any]] = {}
    for item in mounts:
        if not isinstance(item, dict):
            raise DiagnosticError("diagnostic container mount record is invalid")
        destination = item.get("Destination")
        if not isinstance(destination, str) or destination in observed:
            raise DiagnosticError("diagnostic container mount destinations are not unique")
        observed[destination] = item
    if set(observed) != set(expected):
        raise DiagnosticError("diagnostic container mount destinations differ")
    for target, (path, writable) in expected.items():
        item = observed[target]
        if (
            item.get("Type") != "bind"
            or item.get("RW") is not writable
            or not _source_matches(item.get("Source"), path)
        ):
            raise DiagnosticError(f"diagnostic mount mismatch: {target}")


def validate_container_record(
    record: Mapping[str, Any], *, image: str, execution: Path, driver: Path, output: Path,
    expected_env: Mapping[str, str],
) -> dict[str, Any]:
    if record.get("Image") != image:
        raise DiagnosticError("diagnostic container image changed")
    config = record.get("Config")
    if (
        not isinstance(config, dict)
        or config.get("User") != "65532:65532"
        or record.get("Path") != CONTAINER_PATH
        or record.get("Args") != list(CONTAINER_ARGS)
    ):
        raise DiagnosticError("diagnostic container user or command differs")
    if not isinstance(expected_env, Mapping) or any(
        not isinstance(key, str) or not isinstance(value, str)
        for key, value in expected_env.items()
    ):
        raise DiagnosticError("expected diagnostic environment is invalid")
    configured_env = config.get("Env")
    if not isinstance(configured_env, list) or any(
        not isinstance(item, str) or "=" not in item for item in configured_env
    ):
        raise DiagnosticError("diagnostic container environment is invalid")
    observed_env: dict[str, str] = {}
    for item in configured_env:
        key, value = item.split("=", 1)
        if key in expected_env:
            observed_env[key] = value
    if any(observed_env.get(key) != value for key, value in expected_env.items()):
        raise DiagnosticError("diagnostic container environment overrides differ")
    labels = config.get("Labels")
    if (
        not isinstance(labels, dict)
        or labels.get("fullmag.diagnostic") != "managed-fem-startup-v1"
        or labels.get("fullmag.diagnostic-source") != "terminal-failed-job"
    ):
        raise DiagnosticError("diagnostic container labels differ")
    host = record.get("HostConfig")
    if not isinstance(host, dict) or (
        host.get("ReadonlyRootfs") is not True
        or host.get("NetworkMode") != "none"
        or host.get("NanoCpus") != 1_000_000_000
        or host.get("Memory") != MEMORY_BYTES
        or host.get("MemorySwap") != MEMORY_BYTES
        or host.get("PidsLimit") != PIDS_LIMIT
        or host.get("DeviceRequests") not in (None, [])
        or host.get("Tmpfs") != {"/tmp": TMPFS.split(":", 1)[1]}
        or host.get("CapDrop") != ["ALL"]
        or host.get("SecurityOpt") != ["no-new-privileges:true"]
    ):
        raise DiagnosticError("diagnostic container policy differs")
    _validate_mounts(record, execution, driver, output)
    state = record.get("State")
    if not isinstance(state, dict):
        raise DiagnosticError("diagnostic container has no state")
    return dict(state)


def build_probe_command(docker_executable: str, container_id: str, argv: Sequence[str]) -> list[str]:
    if not CONTAINER_RE.fullmatch(container_id) or not argv:
        raise DiagnosticError("probe identity is invalid")
    if any(not isinstance(value, str) or not value for value in argv):
        raise DiagnosticError("probe argv is invalid")
    return [
        docker_executable, "--context", "desktop-linux", "exec", container_id,
        "/usr/bin/timeout", "--signal=TERM",
        f"--kill-after={TERM_GRACE_SECONDS}s", f"{PROBE_TIMEOUT_SECONDS}s", *argv,
    ]


def _drain(pipe: Any, sink: dict[str, Any]) -> None:
    data = bytearray()
    truncated = False
    try:
        while True:
            chunk = pipe.read(8192)
            if not chunk:
                break
            remaining = max(0, MAX_CAPTURE_BYTES - len(data))
            data.extend(chunk[:remaining])
            if len(chunk) > remaining:
                truncated = True
    except OSError:
        truncated = True
    sink.update(
        data=bytes(data),
        truncated=bool(sink.get("truncated")) or truncated,
    )


def run_bounded_probe(
    command: Sequence[str], *, popen: Callable[..., Any] = subprocess.Popen,
) -> dict[str, Any]:
    environment = {
        key: value for key, value in os.environ.items()
        if key not in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")
    }
    process = popen(
        list(command), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment,
    )
    stdout: dict[str, Any] = {}
    stderr: dict[str, Any] = {}
    threads = [
        threading.Thread(target=_drain, args=(process.stdout, stdout), daemon=True),
        threading.Thread(target=_drain, args=(process.stderr, stderr), daemon=True),
    ]
    for thread in threads:
        thread.start()
    timed_out = False
    return_code: int | None = None
    termination = "natural"
    try:
        return_code = process.wait(timeout=PROBE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        timed_out = True
        termination = "term_then_kill"
        with suppress(Exception):
            process.terminate()
        try:
            return_code = process.wait(timeout=TERM_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            with suppress(Exception):
                process.kill()
            with suppress(Exception):
                return_code = process.wait(timeout=TERM_GRACE_SECONDS)
    for thread, sink in zip(threads, (stdout, stderr)):
        thread.join(TERM_GRACE_SECONDS)
        if thread.is_alive():
            sink["truncated"] = True
    return {
        "stdout": stdout.get("data", b""),
        "stderr": stderr.get("data", b""),
        "stdout_truncated": bool(stdout.get("truncated")),
        "stderr_truncated": bool(stderr.get("truncated")),
        "return_code": return_code,
        "timed_out": timed_out or return_code == 124,
        "termination": termination if timed_out else (
            "inner_timeout" if return_code == 124 else "natural"
        ),
    }


def _write_probe(output: Path, name: str, result: Mapping[str, Any]) -> dict[str, Any]:
    directory = output / "probes"
    if not directory.exists():
        directory.mkdir()
    if is_link(directory) or not directory.is_dir():
        raise DiagnosticError("probe output directory is invalid")
    stdout = result.get("stdout", b"")
    stderr = result.get("stderr", b"")
    if not isinstance(stdout, bytes) or not isinstance(stderr, bytes):
        raise DiagnosticError("probe output is not bytes")
    if len(stdout) > MAX_CAPTURE_BYTES or len(stderr) > MAX_CAPTURE_BYTES:
        raise DiagnosticError("probe output exceeds 128 KiB")
    stdout_path = directory / f"{name}.stdout.log"
    stderr_path = directory / f"{name}.stderr.log"
    with stdout_path.open("xb") as stream:
        stream.write(stdout)
    with stderr_path.open("xb") as stream:
        stream.write(stderr)
    return {
        "stdout_log": stdout_path.relative_to(output).as_posix(),
        "stderr_log": stderr_path.relative_to(output).as_posix(),
        "stdout_bytes": len(stdout), "stderr_bytes": len(stderr),
        "stdout_truncated": bool(result.get("stdout_truncated")),
        "stderr_truncated": bool(result.get("stderr_truncated")),
        "return_code": result.get("return_code"),
        "timed_out": bool(result.get("timed_out")),
        "termination": result.get("termination"),
    }


def _hashes(context: Mapping[str, Any], driver: Path) -> dict[str, str]:
    binary = context["binary"]
    result = {"driver": _sha256(driver), "fullmag-bin": _sha256(binary)}
    for key, path in context["paths"].items():
        result[f"{key}.json"] = _sha256(path)
    library_directory = binary.parent.parent / "lib"
    if library_directory.is_dir() and not is_link(library_directory):
        for path in sorted(library_directory.glob("libfullmag_fem.so*")):
            if not is_link(path) and path.is_file():
                result[f"runtime-lib/{path.name}"] = _sha256(path)
    return result


def _new_output(layout: Mapping[str, Any], job_id: str) -> Path:
    storage = Path(str(layout["storage_root"])).resolve()
    root = validate_path(Path(str(layout["runs_root"])), storage, "runs root")
    parent = validate_path(root / "startup-diagnostics", storage, "diagnostic root")
    if is_link(parent):
        raise DiagnosticError("diagnostic root is a link")
    parent.mkdir(parents=True, exist_ok=True)
    if is_link(parent) or not parent.is_dir():
        raise DiagnosticError("diagnostic root is not a directory")
    for _ in range(10):
        path = validate_path(parent / f"{job_id}-{uuid.uuid4().hex}", storage, "diagnostic output")
        try:
            path.mkdir()
            return path
        except FileExistsError:
            pass
    raise DiagnosticError("cannot allocate a fresh diagnostic output directory")


def _write_report(path: Path, report: Mapping[str, Any]) -> None:
    atomic_json(path, dict(report))


def _container_record(value: object, expected_id: str | None = None) -> dict[str, Any]:
    if isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict):
        record = value[0]
    elif isinstance(value, dict):
        record = value
    else:
        raise DiagnosticError("Docker inspect did not return one container")
    record_id = record.get("Id")
    if not isinstance(record_id, str) or not CONTAINER_RE.fullmatch(record_id):
        raise DiagnosticError("Docker inspect returned an invalid container ID")
    if expected_id is not None and record_id != expected_id:
        raise DiagnosticError("Docker inspect returned a different container ID")
    return record


def diagnose(
    layout: Mapping[str, Any], job_id: str, *,
    call: Callable[[list[str]], str] = docker,
    popen: Callable[..., Any] = subprocess.Popen,
) -> dict[str, Any]:
    context = _load_job(layout, job_id)
    repo_root = Path(str(layout["repo_root"])).resolve()
    driver = _file(Path(__file__).resolve(), repo_root, "diagnostic driver")
    output = _new_output(layout, job_id)
    if context["run_root"] in output.parents:
        raise DiagnosticError("diagnostic output is inside failed job")
    report_path = output / "diagnostic-report.json"
    report: dict[str, Any] = {
        "schema": DIAGNOSTIC_SCHEMA,
        "source_job_id": job_id,
        "source_worktree_id": layout["worktree_id"],
        "source_profile": context["job"]["profile"],
        "source_queue_state": context["job"]["state"],
        "source_exit_code": context["job"]["exit_code"],
        "source_digest": context["job"]["source_digest"],
        "source_image_digest": context["image"],
        "source_native_snapshot_sha256": context["native_identity"]["source_snapshot_sha256"],
        "source_receipt_error": context["records"]["build_receipt"].get("error"),
        "qualification": "NOT VERIFIED",
        "status": "diagnostic_only",
        "state": "prepared",
        "created_at": utc_now(),
        "paths": {
            "failed_execution": str(context["execution"]),
            "driver": str(driver),
            "output": str(output),
            "run_root": str(context["run_root"]),
            "capsule": str(context["capsule"]),
            "runtime_binary": str(context["binary"]),
        },
        "file_sha256": None,
        "container": {},
        "probes": [],
        "notes": [
            "Forensic diagnostic only; no runtime qualification.",
            "The failed managed worker is never restarted or mutated.",
        ],
    }
    _write_report(report_path, report)
    container_id: str | None = None
    stopped = False
    initial_hashes: dict[str, str] | None = None
    try:
        initial_hashes = _hashes(context, driver)
        report["file_sha256"] = initial_hashes
        _write_report(report_path, report)
        image_library_path = _image_info(call, context["image"])
        name = f"fullmag-startup-diagnostic-{job_id[:12]}-{uuid.uuid4().hex[:12]}"
        create = build_create_command(
            image=context["image"], name=name, execution=context["execution"],
            driver=driver, output=output, image_library_path=image_library_path,
        )
        expected_env = _diagnostic_environment(image_library_path)
        report["state"] = "create_requested"
        report["container"] = {
            "name": name, "image_digest": context["image"],
            "limits": {
                "cpus": 1, "memory_bytes": MEMORY_BYTES, "pids_limit": PIDS_LIMIT,
                "tmpfs": TMPFS, "network": "none", "rootfs": "read-only",
                "gpu_passthrough": False,
            },
            "mounts": {
                "/workspace": {"host_path": str(context["execution"]), "read_only": True},
                DRIVER_TARGET: {"host_path": str(driver), "read_only": True},
                OUTPUT_TARGET: {"host_path": str(output), "read_only": False},
            },
        }
        _write_report(report_path, report)
        created_id = call(create).strip()
        if not CONTAINER_RE.fullmatch(created_id):
            raise DiagnosticError("Docker did not return a full container ID")
        container_id = created_id
        report["container"]["id"] = container_id
        report["container"]["created_at"] = utc_now()
        report["state"] = "created"
        _write_report(report_path, report)
        created = _container_record(
            json.loads(call(["inspect", container_id])), container_id,
        )
        report["container"]["created_state"] = validate_container_record(
            created, image=context["image"], execution=context["execution"],
            driver=driver, output=output, expected_env=expected_env,
        )
        report["state"] = "start_requested"
        _write_report(report_path, report)
        call(["start", container_id])
        started = _container_record(
            json.loads(call(["inspect", container_id])), container_id,
        )
        state = validate_container_record(
            started, image=context["image"], execution=context["execution"],
            driver=driver, output=output, expected_env=expected_env,
        )
        if state.get("Running") is not True:
            raise DiagnosticError("diagnostic container did not remain running")
        report["container"]["startup_stamp"] = utc_now()
        report["container"]["docker_started_at"] = state.get("StartedAt")
        report["container"]["started_state"] = state
        report["state"] = "running"
        _write_report(report_path, report)
        executable = shutil.which("docker.exe")
        if executable is None:
            raise DiagnosticError("docker.exe is unavailable")
        for name, argv in PROBES:
            command = build_probe_command(executable, container_id, argv)
            result = run_bounded_probe(command, popen=popen)
            evidence = _write_probe(output, name, result)
            evidence["command"] = list(argv)
            report["probes"].append(evidence)
            _write_report(report_path, report)
        report["state"] = "stop_requested"
        _write_report(report_path, report)
        call(["stop", "--time", str(TERM_GRACE_SECONDS), container_id])
        final = _container_record(
            json.loads(call(["inspect", container_id])), container_id,
        )
        final_state = validate_container_record(
            final, image=context["image"], execution=context["execution"],
            driver=driver, output=output, expected_env=expected_env,
        )
        if final_state.get("Running") is not False or final_state.get("Status") != "exited":
            raise DiagnosticError("diagnostic container was not confirmed stopped")
        stopped = True
        report["container"]["final_state"] = final_state
        report["container"]["stopped_at"] = utc_now()
        final_hashes = _hashes(context, driver)
        if final_hashes != initial_hashes:
            raise DiagnosticError("approved bytes changed during diagnostic")
        report["file_sha256_final"] = final_hashes
        report["state"] = "completed"
        report["finished_at"] = utc_now()
        _write_report(report_path, report)
        return report
    except (DiagnosticError, CoordinatorError, OSError, ValueError, json.JSONDecodeError) as error:
        report["state"] = "blocked"
        report["failure"] = bounded_text(error)
        report["finished_at"] = utc_now()
        _write_report(report_path, report)
        raise DiagnosticError(f"{error}; retained report: {report_path}") from error
    finally:
        if container_id and not stopped:
            stop_error: Exception | None = None
            try:
                call(["stop", "--time", str(TERM_GRACE_SECONDS), container_id])
            except Exception as error:
                stop_error = error
            try:
                final = _container_record(
                    json.loads(call(["inspect", container_id])), container_id,
                )
                final_state = validate_container_record(
                    final, image=context["image"], execution=context["execution"],
                    driver=driver, output=output, expected_env=expected_env,
                )
            except Exception as error:
                report["container"]["stop_confirmation"] = "unknown"
                report["container"]["stop_error"] = bounded_text(
                    stop_error or error
                )
            else:
                if (
                    final_state.get("Running") is False
                    and final_state.get("Status") == "exited"
                ):
                    report["container"]["final_state"] = final_state
                    report["container"]["stopped_at"] = utc_now()
                    report["container"]["stop_after_failure"] = True
                    report["container"]["stop_confirmation"] = "confirmed"
                    if stop_error is not None:
                        report["container"]["stop_request_error"] = bounded_text(stop_error)
                else:
                    report["container"]["stop_confirmation"] = "unknown"
                    report["container"]["stop_observed_state"] = final_state
                    if stop_error is not None:
                        report["container"]["stop_request_error"] = bounded_text(stop_error)
            with suppress(Exception):
                _write_report(report_path, report)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--job-id", required=True)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        layout = resolve_layout(Path(args.repo_root), "windows-native")
        initialize(layout)
        with build_lock(layout):
            report = diagnose(layout, args.job_id)
    except (DiagnosticError, CoordinatorError, StorageError, OSError, ValueError) as error:
        print(f"[managed FEM startup diagnostic] {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
