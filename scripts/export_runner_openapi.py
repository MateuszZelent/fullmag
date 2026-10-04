#!/usr/bin/env python3
"""Export OpenAPI from an already completed managed BuildRunner package.

This is a diagnostic artifact route.  It never builds, initializes storage,
starts the runner, or changes the retained package.  The package is accepted
only after the existing queue, coordinator receipt, source capsule, and build
receipt validators agree on one clean source identity.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, Callable, Mapping, Sequence


SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import fullmag_storage as storage  # noqa: E402
from local_runner.build_entrypoint import PROFILES, required_outputs_for_profile  # noqa: E402
from local_runner.build_executor import (  # noqa: E402
    capsule_path,
    trusted_identity,
    validate_build_receipt,
)
from local_runner.build_source import bind_identity  # noqa: E402
from local_runner.worker_entrypoint import verify_source  # noqa: E402


JOB_ID_RE = re.compile(r"[a-f0-9]{32}\Z")
COMMIT_RE = re.compile(r"[a-f0-9]{40}\Z")
SHA256_RE = re.compile(r"[a-f0-9]{64}\Z")
IMAGE_RE = re.compile(r"sha256:[a-f0-9]{64}\Z")
MAX_DOCUMENT_BYTES = 64 * 1024 * 1024
MAX_METADATA_BYTES = 4 * 1024 * 1024
MAX_STREAM_BYTES = 64 * 1024 * 1024
DOCKER_CONTROL_TIMEOUT_SECONDS = 60
EXPORT_TIMEOUT_SECONDS = 180
READER_JOIN_TIMEOUT_SECONDS = 10.0
OPENAPI_ROUTE = "/v2/sessions/current/status"


class ExportError(RuntimeError):
    """The managed export cannot be trusted or safely completed."""


@dataclass(frozen=True)
class ManagedBuild:
    layout: Mapping[str, Any]
    job: Mapping[str, Any]
    journal: Mapping[str, Any]
    context: Mapping[str, Any]
    build_receipt: Mapping[str, Any]
    run_root: Path
    capsule: Path
    package: Path
    api_binary: Path
    source_manifest: Mapping[str, Any]
    build_receipt_path: Path
    source_manifest_path: Path
    validated_api_binary_sha256: str
    validated_build_receipt_sha256: str
    validated_source_manifest_sha256: str

    def input_hash_mismatches(self) -> list[str]:
        checks = (
            ("api_binary", self.api_binary, self.validated_api_binary_sha256),
            ("build_receipt", self.build_receipt_path, self.validated_build_receipt_sha256),
            ("source_manifest", self.source_manifest_path, self.validated_source_manifest_sha256),
        )
        mismatches = []
        for name, path, expected in checks:
            try:
                actual = _sha256(path)
            except (OSError, ExportError) as error:
                mismatches.append(f"{name}: unreadable ({error})")
                continue
            if actual != expected:
                mismatches.append(f"{name}: expected {expected}, observed {actual}")
        return mismatches


@dataclass(frozen=True)
class ProcessCapture:
    returncode: int | None
    stdout: bytes
    stderr: bytes
    timed_out: bool
    output_limit_exceeded: bool
    cleanup_confirmed: bool = True
    cleanup_failed: bool = False
    cleanup_detail: str | None = None
    spawn_failed: bool = False
    started: bool = False
    capture_failed: bool = False
    capture_detail: str | None = None


@dataclass(frozen=True)
class CleanupResult:
    confirmed: bool
    failed: bool = False
    detail: str | None = None


def _fail(message: str) -> None:
    raise ExportError(message)


def _require(condition: bool, message: str) -> None:
    if not condition:
        _fail(message)


def _preflight_ancestors(path: Path, label: str) -> Path:
    """Reject symlink/junction/reparse points on the complete existing path."""

    path = Path(path)
    current = path
    while True:
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            pass
        except OSError as error:
            raise ExportError(f"Cannot inspect {label}: {current}") from error
        else:
            if stat.S_ISLNK(metadata.st_mode) or storage.is_link(current):
                _fail(f"{label} traverses a symlink or reparse point: {current}")
        if current.parent == current:
            break
        current = current.parent
    return path


def _safe_validate(value: Path, root: Path, label: str) -> Path:
    _preflight_ancestors(Path(value), label)
    result = storage.validate_path(value, root, label)
    _preflight_ancestors(result, label)
    return result


def _preflight_tree(root: Path, label: str) -> None:
    _preflight_ancestors(root, label)
    _regular(root, label, directory=True)
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        _preflight_ancestors(Path(current), label)
        for name in (*directories, *files):
            _preflight_ancestors(Path(current) / name, label)


def _regular(path: Path, label: str, *, directory: bool | None = None) -> Path:
    """Return a path after rejecting links/reparse points and wrong type."""

    path = _preflight_ancestors(Path(path), label)
    try:
        info = path.lstat()
    except OSError as error:
        raise ExportError(f"{label} is not readable: {path}") from error
    if storage.is_link(path) or stat.S_ISLNK(info.st_mode):
        _fail(f"{label} must not be a symlink or reparse point: {path}")
    if directory is True and not stat.S_ISDIR(info.st_mode):
        _fail(f"{label} must be a directory: {path}")
    if directory is False and not stat.S_ISREG(info.st_mode):
        _fail(f"{label} must be a regular file: {path}")
    return path


def _bounded_json(path: Path, label: str, *, limit: int = MAX_METADATA_BYTES) -> dict[str, Any]:
    path = _regular(path, label, directory=False)
    try:
        before = path.stat()
        if before.st_size > limit:
            _fail(f"{label} is larger than the bounded metadata limit: {path}")
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if (not stat.S_ISREG(opened.st_mode) or opened.st_size > limit
                    or opened.st_size != before.st_size):
                _fail(f"{label} changed or is not a bounded regular file: {path}")
            content = stream.read(limit + 1)
        if len(content) != before.st_size or len(content) > limit:
            _fail(f"{label} changed or exceeded its bounded read: {path}")
    except OSError as error:
        raise ExportError(f"{label} is not readable: {path}") from error
    try:
        value = json.loads(content.decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ExportError(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        _fail(f"{label} must be a JSON object: {path}")
    return value


def _sha256(path: Path) -> str:
    _regular(path, "hashed file", directory=False)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def _write_exclusive(path: Path, content: bytes) -> None:
    _require(not path.exists(), f"Refusing to overwrite managed evidence: {path}")
    try:
        with path.open("xb") as stream:
            stream.write(content)
    except FileExistsError as error:
        raise ExportError(f"Managed evidence path appeared concurrently: {path}") from error
    except OSError as error:
        raise ExportError(f"Cannot write managed evidence: {path}") from error


def _write_json_exclusive(path: Path, value: Mapping[str, Any]) -> None:
    _write_exclusive(path, (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def _read_queue_job(queue_path: Path, job_id: str) -> dict[str, Any]:
    """Read exactly one job over SQLite's read-only URI without migrations."""

    queue_path = _regular(queue_path, "runner queue", directory=False)
    uri = queue_path.as_uri() + "?mode=ro"
    database = None
    try:
        database = sqlite3.connect(uri, uri=True, timeout=5, isolation_level=None)
        database.row_factory = sqlite3.Row
        database.execute("PRAGMA query_only=ON")
        row = database.execute(
            "SELECT job_id, owner, worktree_id, source_digest, profile, operation, "
            "payload, state, exit_code FROM jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()
    except sqlite3.Error as error:
        raise ExportError(f"Cannot read the runner queue in read-only mode: {queue_path}") from error
    finally:
        if database is not None:
            database.close()
    if row is None:
        _fail(f"Managed build job does not exist: {job_id}")
    job = dict(row)
    try:
        job["payload"] = json.loads(job["payload"])
    except (TypeError, json.JSONDecodeError) as error:
        raise ExportError("Managed build queue payload is malformed") from error
    if not isinstance(job["payload"], dict):
        _fail("Managed build queue payload must be an object")
    return job


def _host_path(raw: Any) -> Path:
    """Translate a Docker Desktop daemon path back to this Windows host."""

    if not isinstance(raw, str) or not raw or "\x00" in raw:
        _fail("Managed source mount path is invalid")
    normalized = raw.replace("\\", "/")
    if os.name == "nt":
        match = re.fullmatch(r"/run/desktop/mnt/host/([A-Za-z])/(.*)", normalized)
        if match:
            normalized = f"{match.group(1)}:/{match.group(2)}"
        match = re.fullmatch(r"/host_mnt/([A-Za-z])/(.*)", normalized)
        if match:
            normalized = f"{match.group(1)}:/{match.group(2)}"
    path = Path(normalized)
    if not path.is_absolute():
        _fail("Managed source mount must be an absolute host path")
    return path


def _source_mount(journal: Mapping[str, Any]) -> Path:
    mounts = journal.get("mounts")
    if not isinstance(mounts, list):
        _fail("Managed build journal has no mount identity")
    matches: list[Path] = []
    for item in mounts:
        if not isinstance(item, list) or len(item) != 4:
            continue
        if item[0] == "bind" and item[2] == "/source" and item[3] is False:
            matches.append(_host_path(item[1]))
    if len(matches) != 1:
        _fail("Managed source capsule mount is missing or ambiguous")
    return matches[0]


def _validate_native_identity(native: Any, expected_commit: str) -> dict[str, Any]:
    if not isinstance(native, dict):
        _fail("Managed build has no native source identity")
    if native.get("schema") != "fullmag.source-snapshot.v2":
        _fail("Managed build native source identity schema is unsupported")
    if native.get("head_commit_full") != expected_commit:
        _fail("Managed build source commit differs from the requested commit")
    if native.get("source_snapshot_dirty") is not False:
        _fail("Managed build source identity is dirty")
    snapshot = native.get("source_snapshot_sha256")
    if not isinstance(snapshot, str) or not SHA256_RE.fullmatch(snapshot):
        _fail("Managed build source snapshot identity is invalid")
    return native


def _validate_openapi_document(raw: bytes, expected_commit: str, expected_snapshot: str) -> dict[str, Any]:
    if len(raw) == 0 or len(raw) > MAX_DOCUMENT_BYTES:
        _fail("Managed OpenAPI stdout is empty or exceeds the 64 MiB limit")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ExportError("Managed OpenAPI stdout is not valid UTF-8 JSON") from error
    if not isinstance(document, dict):
        _fail("Managed OpenAPI export must be a JSON object")
    identity = document.get("x-fullmag-build-identity")
    if not isinstance(identity, dict):
        _fail("Managed OpenAPI export is missing build identity")
    if identity.get("git_commit") != expected_commit \
            or identity.get("source_snapshot_sha256") != expected_snapshot \
            or identity.get("worktree_state") != "clean":
        _fail("Managed OpenAPI export does not match the expected clean source identity")
    built_at = identity.get("built_at_utc")
    if not isinstance(built_at, str) or not built_at.strip():
        _fail("Managed OpenAPI export has no build timestamp")
    try:
        datetime.fromisoformat(built_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ExportError("Managed OpenAPI build timestamp is not an ISO timestamp") from error
    paths = document.get("paths")
    if not isinstance(paths, dict) or not isinstance(paths.get(OPENAPI_ROUTE), dict):
        _fail(f"Managed OpenAPI export omitted the canonical session status resource: {OPENAPI_ROUTE}")
    return document


def _validate_managed_build(layout: Mapping[str, Any], job_id: str, expected_commit: str) -> ManagedBuild:
    if not JOB_ID_RE.fullmatch(job_id):
        _fail("A managed BuildRunner job ID must be exactly 32 lowercase hexadecimal characters")
    if not COMMIT_RE.fullmatch(expected_commit):
        _fail("Expected commit must be exactly 40 lowercase hexadecimal characters")
    storage_root = _safe_validate(Path(layout["storage_root"]), Path(layout["storage_root"]), "storage root")
    queue_path = _safe_validate(storage_root / "index" / "runner-jobs.sqlite", storage_root, "runner queue")
    job = _read_queue_job(queue_path, job_id)
    if job.get("job_id") != job_id or job.get("worktree_id") != layout.get("worktree_id"):
        _fail("Runner queue job belongs to another project/worktree")
    if job.get("operation") != "build" or job.get("state") != "succeeded" or job.get("exit_code") != 0:
        _fail("Runner queue job is not a terminal successful build")
    if not isinstance(job.get("source_digest"), str) or not SHA256_RE.fullmatch(job["source_digest"]):
        _fail("Runner queue source digest is invalid")
    native_from_job = _validate_native_identity(job.get("payload", {}).get("native_source_identity"), expected_commit)
    # resolve_layout().runs_root already includes this checkout's worktree ID;
    # the coordinator uses the same canonical root/runs/<worktree>/<job> path.
    run_root = _safe_validate(Path(layout["runs_root"]) / job_id, storage_root, "managed build run")
    _regular(run_root, "managed build run", directory=True)
    journal_path = _safe_validate(run_root / "receipt.json", run_root, "coordinator receipt")
    context_path = _safe_validate(run_root / "trusted" / "context.json", run_root, "trusted context")
    journal = _bounded_json(journal_path, "coordinator receipt")
    if (journal.get("schema") != "fullmag.local-runner.coordinator.v1"
            or journal.get("phase") != "terminal" or journal.get("state") != "succeeded"
            or journal.get("exit_code") != 0 or journal.get("operation") != "build"):
        _fail("Coordinator receipt is not a terminal successful build")
    for key in ("job_id", "source_digest", "profile"):
        if journal.get(key) != job.get(key):
            _fail(f"Coordinator receipt does not match queue identity: {key}")
    image = journal.get("image_digest")
    if not isinstance(image, str) or not IMAGE_RE.fullmatch(image):
        _fail("Coordinator receipt does not contain an immutable image digest")
    hashes = journal.get("trusted_hashes")
    if not isinstance(hashes, dict) or set(hashes) != {"context.json", "build_entrypoint.py", "worker_entrypoint.py"}:
        _fail("Coordinator receipt has incomplete trusted execution inputs")
    trusted_identity(run_root, journal, storage_root)
    # load_context performs the existing full native identity validation.
    from local_runner.build_entrypoint import load_context
    context = load_context(context_path, job_id=job_id, source_digest=job["source_digest"], profile=job["profile"])
    if context.get("image_digest") != image or context.get("native_source_identity") != native_from_job:
        _fail("Trusted execution context does not match the queue/coordinator identity")
    native = _validate_native_identity(context.get("native_source_identity"), expected_commit)
    job_for_receipt = dict(job)
    job_for_receipt["payload"] = dict(job["payload"])
    job_for_receipt["payload"]["native_source_identity"] = native
    artifacts = _safe_validate(run_root / "artifacts", run_root, "managed build artifacts")
    _regular(artifacts, "managed build artifacts", directory=True)
    build_receipt_path = _safe_validate(artifacts / "build-receipt.json", artifacts, "build receipt")
    _preflight_tree(artifacts, "managed build artifacts")
    build_receipt = validate_build_receipt(artifacts, job_for_receipt, journal)
    required = required_outputs_for_profile(job["profile"])
    # The receipt validator enforces the complete contract of this profile;
    # exporting its API does not require frontend or release-only outputs.
    if "bin/fullmag-api" not in required:
        _fail("The selected BuildRunner profile does not declare the fullmag-api output")
    source_mount = _safe_validate(_source_mount(journal), storage_root, "source capsule mount")
    expected_capsule = capsule_path(storage_root, job_for_receipt)
    if source_mount.resolve() != expected_capsule.resolve():
        _fail("Coordinator source mount differs from the canonical source capsule")
    _regular(expected_capsule, "source capsule", directory=True)
    _preflight_tree(expected_capsule, "source capsule")
    source_manifest_path = _safe_validate(expected_capsule / "manifest.json", expected_capsule, "source capsule manifest")
    source_manifest = verify_source(expected_capsule, job["source_digest"])
    if source_manifest.get("source_mode") != "commit" or source_manifest.get("resolved_commit") != expected_commit:
        _fail("Source capsule does not match the requested clean commit")
    bind_identity(native, source_manifest)
    package = _safe_validate(run_root / "artifacts" / "outputs" / ".fullmag" / "local", run_root, "runtime package")
    _regular(package, "runtime package", directory=True)
    api_binary = _safe_validate(package / "bin" / "fullmag-api", package, "fullmag-api binary")
    _regular(api_binary, "fullmag-api binary", directory=False)
    if api_binary.stat().st_size == 0:
        _fail("fullmag-api binary is empty")
    api_relative = "outputs/.fullmag/local/bin/fullmag-api"
    api_entries = [entry for entry in build_receipt["artifacts"] if entry.get("path") == api_relative]
    if len(api_entries) != 1 or not SHA256_RE.fullmatch(str(api_entries[0].get("sha256", ""))):
        _fail("Build receipt has no unique fullmag-api artifact hash")
    validated_api_binary_sha256 = api_entries[0]["sha256"]
    if _sha256(api_binary) != validated_api_binary_sha256:
        _fail("fullmag-api changed while the build receipt was being validated")
    validated_build_receipt_sha256 = _sha256(build_receipt_path)
    validated_source_manifest_sha256 = _sha256(source_manifest_path)
    return ManagedBuild(
        layout=layout,
        job=job_for_receipt,
        journal=journal,
        context=context,
        build_receipt=build_receipt,
        run_root=run_root,
        capsule=expected_capsule,
        package=package,
        api_binary=api_binary,
        source_manifest=source_manifest,
        build_receipt_path=build_receipt_path,
        source_manifest_path=source_manifest_path,
        validated_api_binary_sha256=validated_api_binary_sha256,
        validated_build_receipt_sha256=validated_build_receipt_sha256,
        validated_source_manifest_sha256=validated_source_manifest_sha256,
    )


def _docker_executable() -> str:
    executable = shutil.which("docker.exe") or shutil.which("docker")
    if not executable:
        _fail("Docker executable is unavailable")
    return executable


def _docker_base() -> list[str]:
    return [_docker_executable(), "--context", "desktop-linux"]


def _docker_control(arguments: Sequence[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [*_docker_base(), *arguments],
            capture_output=True,
            text=True,
            timeout=DOCKER_CONTROL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ExportError("Docker control operation failed") from error


def _owned_container(name: str, label: str, image: str) -> tuple[dict[str, Any] | None, str | None]:
    """Inspect only an exact generated name and verify its ownership contract."""

    listed = _docker_control(["ps", "-aq", "--no-trunc", "--filter", f"name=^/{name}$"])
    if listed.returncode != 0:
        return None, "cannot list the managed export container"
    identifiers = [line.strip() for line in listed.stdout.splitlines() if line.strip()]
    if not identifiers:
        return None, None
    if len(identifiers) != 1 or not re.fullmatch(r"[a-f0-9]{64}", identifiers[0]):
        return None, "managed export container identity is ambiguous"
    expected_identifier = identifiers[0]
    inspected = _docker_control(["inspect", expected_identifier])
    if inspected.returncode != 0:
        return None, "cannot inspect the managed export container"
    try:
        payload = json.loads(inspected.stdout)
    except (TypeError, json.JSONDecodeError):
        return None, "managed export container inspection is malformed"
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        return None, "managed export container inspection is ambiguous"
    value = payload[0]
    labels = value.get("Config", {}).get("Labels") or {}
    if (value.get("Id") != expected_identifier
            or value.get("Name") != f"/{name}"
            or labels.get("com.fullmag.fullmag-openapi-export") != label
            or value.get("Image") != image):
        return None, "refusing to touch a container without exact managed export ownership or identity continuity"
    return value, None


def _cleanup_owned_container(name: str, label: str, image: str) -> CleanupResult:
    """Stop/remove only the exact export container and prove it is gone."""

    try:
        observed, error = _owned_container(name, label, image)
        if error:
            return CleanupResult(False, True, error)
        if observed is not None:
            expected_identifier = observed.get("Id")
            if not isinstance(expected_identifier, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_identifier):
                return CleanupResult(False, True, "managed export container ID is invalid")
            if observed.get("State", {}).get("Running") is True:
                stopped = _docker_control(["stop", "--time", "5", expected_identifier])
                if stopped.returncode != 0:
                    observed, error = _owned_container(name, label, image)
                    if error:
                        return CleanupResult(False, True, error)
                    if observed is None:
                        return CleanupResult(True, False, None)
                    if observed.get("Id") != expected_identifier:
                        return CleanupResult(False, True, "managed export container identity changed during stop")
                    return CleanupResult(False, True, "owned export container did not stop")
                observed, error = _owned_container(name, label, image)
                if error:
                    return CleanupResult(False, True, error)
                if observed is None:
                    return CleanupResult(True, False, None)
                if observed.get("Id") != expected_identifier:
                    return CleanupResult(False, True, "managed export container identity changed after stop")
            removed = _docker_control(["rm", "--force", expected_identifier])
            if removed.returncode != 0:
                observed, error = _owned_container(name, label, image)
                if error:
                    return CleanupResult(False, True, error)
                if observed is None:
                    return CleanupResult(True, False, None)
                if observed.get("Id") != expected_identifier:
                    return CleanupResult(False, True, "managed export container identity changed during removal")
                return CleanupResult(False, True, "owned export container did not remove")
            observed, error = _owned_container(name, label, image)
            if error:
                return CleanupResult(False, True, error)
            if observed is not None:
                if observed.get("Id") != expected_identifier:
                    return CleanupResult(False, True, "managed export container identity changed after removal")
                return CleanupResult(False, True, "owned export container remains after removal")
        return CleanupResult(True, False, None)
    except ExportError as error:
        return CleanupResult(False, True, str(error))


def _inspect_image(image_digest: str, run: Callable[..., subprocess.CompletedProcess[str]] | None = None) -> dict[str, Any]:
    if not IMAGE_RE.fullmatch(image_digest):
        _fail("Only an immutable sha256 image digest may be used")
    runner = run or subprocess.run
    try:
        result = runner(
            [*_docker_base(), "image", "inspect", image_digest],
            capture_output=True,
            text=True,
            timeout=DOCKER_CONTROL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ExportError("Docker image inspection failed") from error
    if result.returncode != 0:
        _fail("The BuildRunner image digest is not available locally")
    try:
        value = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError) as error:
        raise ExportError("Docker image inspection returned malformed JSON") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        _fail("Docker image inspection did not return exactly one image")
    inspected = value[0]
    if inspected.get("Id") != image_digest or inspected.get("Config", {}).get("Volumes"):
        _fail("Docker image identity or anonymous-volume contract mismatch")
    return inspected


def docker_run_argv(build: ManagedBuild, export_id: str) -> list[str]:
    """Build a direct, networkless, read-only command with no shell."""

    image = build.journal["image_digest"]
    _require(IMAGE_RE.fullmatch(image) is not None, "Invalid managed image digest")
    _require(re.fullmatch(r"[a-f0-9]{32}", export_id) is not None, "Invalid managed export ID")
    container_name = f"fullmag-openapi-{export_id}"
    package = str(build.package.resolve())
    profile = PROFILES.get(build.job["profile"])
    if profile is None:
        _fail("Managed build profile is not recognized by the trusted registry")
    # Use the declared image-owned ABI paths of the validated profile.
    # Runtime-v2 MFEM/PETSc/SLEPc live outside the legacy dependency prefix.
    library_paths = ["/package/lib"]
    library_paths.extend(path for path in profile.environment.get("LD_LIBRARY_PATH", "").split(":") if path)
    library_paths.append("/opt/fullmag-deps/lib")
    return [
        *_docker_base(), "run", "--rm", "--pull=never",
        "--name", container_name,
        "--label", f"com.fullmag.fullmag-openapi-export={export_id}",
        "--network=none", "--read-only", "--user", "65532:65532",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--pids-limit", "128", "--cpus", "2", "--memory", "512m",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
        "--mount", f"type=bind,source={package},destination=/package,readonly",
        "--workdir", "/package",
        "--env", "FULLMAG_RUNTIME_ROOT=/package",
        "--env", "FULLMAG_WEB_STATIC_DIR=/package/web",
        "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
        "--env", "PATH=/package/bin:/usr/local/bin:/usr/bin:/bin",
        "--env", f"LD_LIBRARY_PATH={':'.join(library_paths)}",
        "--entrypoint", "/package/bin/fullmag-api", image, "--print-openapi-v2",
    ]


def _reader(stream: Any, buffer: bytearray, state: dict[str, bool]) -> None:
    try:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return
            if len(buffer) + len(chunk) > MAX_STREAM_BYTES:
                state["overflow"] = True
                return
            buffer.extend(chunk)
    except Exception as error:
        state["read_error"] = f"{type(error).__name__}: {error}"


def _terminate_process(process: Any) -> int | None:
    """Boundedly terminate the Docker CLI before touching its pipes."""

    try:
        if process.poll() is None:
            process.kill()
    except Exception:
        pass
    try:
        return process.wait(timeout=10)
    except Exception:
        return None


def _capture(command: Sequence[str], *, timeout: float = EXPORT_TIMEOUT_SECONDS,
             popen: Callable[..., Any] | None = None,
             cleanup: Callable[[], CleanupResult] | None = None) -> ProcessCapture:
    process = None
    stdout = bytearray()
    stderr = bytearray()
    threads: list[threading.Thread] = []
    state: dict[str, Any] = {"overflow": False, "read_error": None}
    timed_out = False
    returncode: int | None = None
    capture_failed = False
    capture_detail: str | None = None
    popen = subprocess.Popen if popen is None else popen
    try:
        try:
            process = popen(list(command), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except Exception as error:
            capture_failed = True
            capture_detail = str(error)
        else:
            threads = [
                threading.Thread(target=_reader, args=(process.stdout, stdout, state), daemon=True),
                threading.Thread(target=_reader, args=(process.stderr, stderr, state), daemon=True),
            ]
            try:
                for thread in threads:
                    thread.start()
                deadline = time.monotonic() + timeout
                while process.poll() is None and not state["overflow"] and not state["read_error"]:
                    if time.monotonic() >= deadline:
                        timed_out = True
                        break
                    time.sleep(0.02)
            except Exception as error:
                capture_failed = True
                capture_detail = str(error)
            if state["read_error"]:
                capture_failed = True
                capture_detail = state["read_error"]
            if timed_out or state["overflow"]:
                capture_detail = capture_detail or ("capture timeout" if timed_out else "capture output limit exceeded")
            if capture_failed or timed_out or state["overflow"]:
                returncode = _terminate_process(process)
            else:
                try:
                    returncode = process.wait(timeout=10)
                except Exception as error:
                    capture_failed = True
                    capture_detail = str(error)
                    returncode = _terminate_process(process)
    finally:
        # A process may still be live after an exception or a bounded wait.
        # Kill/wait happens before cleanup and before closing/joining pipes.
        if process is not None and returncode is None:
            returncode = _terminate_process(process)
        cleanup_result = CleanupResult(True, False, None)
        if cleanup is not None:
            try:
                cleanup_result = cleanup()
            except Exception as error:  # cleanup failure must become an explicit gate
                cleanup_result = CleanupResult(False, True, f"cleanup raised {type(error).__name__}: {error}")
        # Let readers drain EOF before closing their pipes.  Closing first can
        # truncate a successful response or turn a late reader into a false
        # capture failure.  Use one bounded budget for all readers so a broken
        # stream can never hold the export indefinitely.
        reader_pairs = []
        if process is not None:
            reader_pairs = list(zip((process.stdout, process.stderr), threads))
        reader_deadline = time.monotonic() + READER_JOIN_TIMEOUT_SECONDS
        for thread in threads:
            if thread.ident is None:
                continue
            remaining = max(0.0, reader_deadline - time.monotonic())
            thread.join(timeout=remaining)
        unsettled = [thread for thread in threads if thread.ident is not None and thread.is_alive()]
        if unsettled:
            capture_failed = True
            capture_detail = capture_detail or (
                f"reader thread did not settle within {READER_JOIN_TIMEOUT_SECONDS:g}s"
            )
        for stream, thread in reader_pairs:
            # Never close a pipe while its reader is still blocked.  The
            # daemon reader remains bounded by the process lifetime and the
            # failed result records that it did not settle.
            if thread.ident is not None and thread.is_alive():
                continue
            try:
                stream.close()
            except Exception as error:
                capture_failed = True
                capture_detail = capture_detail or f"stream close failed: {type(error).__name__}: {error}"
        if state["read_error"]:
            capture_failed = True
            capture_detail = state["read_error"]
    return ProcessCapture(
        returncode, bytes(stdout), bytes(stderr), timed_out, bool(state["overflow"]),
        cleanup_confirmed=cleanup_result.confirmed,
        cleanup_failed=cleanup_result.failed, cleanup_detail=cleanup_result.detail,
        spawn_failed=process is None and capture_failed, started=process is not None,
        capture_failed=capture_failed, capture_detail=capture_detail,
    )


def _new_evidence_root(layout: Mapping[str, Any]) -> Path:
    storage_root = _safe_validate(Path(layout["storage_root"]), Path(layout["storage_root"]), "storage root")
    runs_root = _safe_validate(Path(layout["runs_root"]), storage_root, "runs_root")
    _regular(runs_root, "runs_root", directory=True)
    parent = _safe_validate(runs_root / "openapi-export", runs_root, "OpenAPI evidence parent")
    if parent.exists():
        _regular(parent, "OpenAPI evidence parent", directory=True)
    else:
        parent.mkdir()
    for _ in range(5):
        candidate = _safe_validate(parent / uuid.uuid4().hex, parent, "OpenAPI evidence run")
        try:
            candidate.mkdir()
            return candidate
        except FileExistsError:
            continue
    _fail("Cannot allocate a unique managed OpenAPI evidence run")


def _record_evidence(root: Path, *, build: ManagedBuild, capture: ProcessCapture,
                     command: Sequence[str], document: Mapping[str, Any] | None,
                     state: str, failure: str | None = None,
                     input_hashes_verified: bool = True,
                     input_hashes_checked: bool = True,
                     input_hash_mismatches: Sequence[str] = ()) -> dict[str, Any]:
    _write_exclusive(root / "stdout.raw.json", capture.stdout)
    _write_exclusive(root / "stderr.raw.log", capture.stderr)
    raw_hash = _sha256(root / "stdout.raw.json")
    stderr_hash = _sha256(root / "stderr.raw.log")
    # These hashes were captured after existing validators passed and before
    # Docker was started. Never replace them with post-run bytes.
    binary_hash = build.validated_api_binary_sha256
    receipt = {
        "schema": "fullmag.managed-package-openapi.v1",
        "state": state,
        "qualification": "NOT VERIFIED",
        "diagnostic_only": True,
        "job_id": build.job["job_id"],
        "profile": build.job["profile"],
        "source_commit": build.context["native_source_identity"]["head_commit_full"],
        "source_snapshot_sha256": build.context["native_source_identity"]["source_snapshot_sha256"],
        "source_digest": build.job["source_digest"],
        "image_digest": build.journal["image_digest"],
        "api_binary_sha256": binary_hash,
        "build_receipt_sha256": build.validated_build_receipt_sha256,
        "source_manifest_sha256": build.validated_source_manifest_sha256,
        "raw_openapi_sha256": raw_hash,
        "stderr_sha256": stderr_hash,
        "stdout_bytes": len(capture.stdout),
        "stderr_bytes": len(capture.stderr),
        "exit_code": capture.returncode,
        "timed_out": capture.timed_out,
        "output_limit_exceeded": capture.output_limit_exceeded,
        "process_started": capture.started,
        "spawn_failed": capture.spawn_failed,
        "capture_failed": capture.capture_failed,
        "capture_detail": capture.capture_detail,
        "cleanup_confirmed": capture.cleanup_confirmed,
        "cleanup_failed": capture.cleanup_failed,
        "cleanup_detail": capture.cleanup_detail,
        "input_hashes_checked": input_hashes_checked,
        "input_hashes_verified": input_hashes_verified,
        "input_hash_mismatches": list(input_hash_mismatches),
        "command": list(command),
        "openapi_route": OPENAPI_ROUTE,
    }
    if failure:
        receipt["failure"] = failure
    if document is not None:
        receipt["openapi_identity"] = document.get("x-fullmag-build-identity")
    _write_json_exclusive(root / "receipt.json", receipt)
    receipt_hash = _sha256(root / "receipt.json")
    proof = {
        "schema": "fullmag.managed-package-openapi-proof.v1",
        "state": state,
        "qualification": "NOT VERIFIED",
        "managed_export_receipt_sha256": receipt_hash,
        "build_receipt_sha256": receipt["build_receipt_sha256"],
        "source_manifest_sha256": receipt["source_manifest_sha256"],
        "api_binary_sha256": binary_hash,
        "raw_openapi_sha256": raw_hash,
        "stderr_sha256": stderr_hash,
        "exit_code": capture.returncode,
        "process_started": capture.started,
        "spawn_failed": capture.spawn_failed,
        "capture_failed": capture.capture_failed,
        "capture_detail": capture.capture_detail,
        "cleanup_confirmed": capture.cleanup_confirmed,
        "cleanup_failed": capture.cleanup_failed,
        "cleanup_detail": capture.cleanup_detail,
        "input_hashes_checked": input_hashes_checked,
        "input_hashes_verified": input_hashes_verified,
        "input_hash_mismatches": list(input_hash_mismatches),
        "source_identity": {
            "git_commit": receipt["source_commit"],
            "source_snapshot_sha256": receipt["source_snapshot_sha256"],
            "worktree_state": "clean",
        },
        "image_digest": receipt["image_digest"],
        "job_id": receipt["job_id"],
    }
    if failure:
        proof["failure"] = failure
    _write_json_exclusive(root / "proof.json", proof)
    return receipt


def export_openapi(repo_root: Path, job_id: str, expected_commit: str,
                   *, layout: Mapping[str, Any] | None = None,
                   image_inspect: Callable[[str], Mapping[str, Any]] | None = None,
                   capture: Callable[[Sequence[str]], ProcessCapture] | None = None) -> Path:
    if layout is None:
        try:
            layout = storage.resolve_layout(repo_root)
        except (OSError, ValueError, storage.StorageError) as error:
            raise ExportError("Cannot resolve the configured canonical Fullmag storage") from error
    build = _validate_managed_build(layout, job_id, expected_commit)
    evidence = _new_evidence_root(layout)
    export_id = evidence.name
    command: Sequence[str] = []
    input_hash_mismatches: list[str] = []
    input_hashes_checked = False
    try:
        input_hash_mismatches = build.input_hash_mismatches()
        input_hashes_checked = True
        if input_hash_mismatches:
            raise ExportError("validated managed inputs changed before Docker start")
        command = docker_run_argv(build, export_id)
        (image_inspect or _inspect_image)(build.journal["image_digest"])
        # Image inspection can run arbitrary operator tooling; recheck the
        # package/receipt/capsule boundary immediately before process start.
        input_hash_mismatches = build.input_hash_mismatches()
        input_hashes_checked = True
        if input_hash_mismatches:
            raise ExportError("validated managed inputs changed before Docker start")
    except (ExportError, OSError, ValueError) as error:
        result = ProcessCapture(None, b"", str(error).encode("utf-8", "replace"), False, False)
        _record_evidence(root=evidence, build=build, capture=result, command=command,
                         document=None, state="failed", failure=str(error),
                         input_hashes_checked=input_hashes_checked,
                         input_hashes_verified=input_hashes_checked and not input_hash_mismatches,
                         input_hash_mismatches=input_hash_mismatches)
        raise ExportError(f"{error}; evidence retained at {evidence}") from error
    cleanup = lambda: _cleanup_owned_container(
        f"fullmag-openapi-{export_id}", export_id, build.journal["image_digest"]
    )
    try:
        if capture is None:
            result = _capture(command, cleanup=cleanup)
        else:
            result = capture(command)
    except Exception as error:
        try:
            cleanup_result = cleanup()
        except Exception as cleanup_error:
            cleanup_result = CleanupResult(False, True, f"cleanup raised {type(cleanup_error).__name__}: {cleanup_error}")
        result = ProcessCapture(None, b"", str(error).encode("utf-8", "replace"), False, False,
                                cleanup_confirmed=cleanup_result.confirmed,
                                cleanup_failed=cleanup_result.failed,
                                cleanup_detail=cleanup_result.detail,
                                spawn_failed=True)
    document: dict[str, Any] | None = None
    failure: str | None = None
    if result.cleanup_failed or not result.cleanup_confirmed:
        failure = result.cleanup_detail or "managed OpenAPI container cleanup was not confirmed"
    elif result.capture_failed:
        failure = result.capture_detail or "managed OpenAPI process capture failed"
    elif result.spawn_failed:
        failure = "managed OpenAPI export process did not start"
    elif result.timed_out:
        failure = "managed OpenAPI export timed out"
    elif result.output_limit_exceeded:
        failure = "managed OpenAPI export exceeded the bounded stdout/stderr limit"
    elif result.returncode != 0:
        failure = f"managed OpenAPI export exited with {result.returncode}"
    input_hash_mismatches = build.input_hash_mismatches()
    input_hashes_checked = True
    input_hashes_verified = input_hashes_checked and not input_hash_mismatches
    if failure is None and not input_hashes_verified:
        failure = "validated managed inputs changed during OpenAPI export"
    if failure is None:
        try:
            document = _validate_openapi_document(
                result.stdout,
                build.context["native_source_identity"]["head_commit_full"],
                build.context["native_source_identity"]["source_snapshot_sha256"],
            )
        except ExportError as error:
            failure = str(error)
    _record_evidence(root=evidence, build=build, capture=result, command=command,
                     document=document, state="succeeded" if failure is None else "failed",
                     failure=failure, input_hashes_checked=input_hashes_checked,
                     input_hashes_verified=input_hashes_verified,
                     input_hash_mismatches=input_hash_mismatches)
    if failure is not None:
        raise ExportError(f"{failure}; evidence retained at {evidence}")
    return evidence


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--expected-commit", required=True)
    args = parser.parse_args(argv)
    try:
        evidence = export_openapi(args.repo_root, args.job_id, args.expected_commit)
    except ExportError as error:
        print(f"export_runner_openapi: {error}", file=sys.stderr)
        return 2
    print(json.dumps({"state": "succeeded", "evidence_root": str(evidence)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
