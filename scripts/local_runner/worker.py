"""Fail-closed construction of one local Fullmag Docker worker command.

This module deliberately builds an ``argv`` list only.  It does not invoke
Docker and it does not accept a shell command from a job request.  The host
coordinator can therefore inspect the complete command before handing it to a
process runner.
"""

from __future__ import annotations

import math
import os
import re
import stat
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Final


OWNER_LABEL_KEY: Final = "owner"
JOB_LABEL_KEY: Final = "job"
OWNER_LABEL_VALUE: Final = "fullmag-local-runner"

MIN_CPUS: Final = 0.25
MAX_CPUS: Final = 16.0
MIN_MEMORY_BYTES: Final = 256 * 1024**2
MAX_MEMORY_BYTES: Final = 64 * 1024**3
MAX_PIDS: Final = 512
TMPFS_SIZE: Final = "64m"

WORKER_ENTRYPOINT: Final = "/opt/fullmag-runner/worker_entrypoint.py"
SOURCE_MOUNT_TARGET: Final = "/source"
BUILD_MOUNT_TARGET: Final = "/build"
ARTIFACT_MOUNT_TARGET: Final = "/artifacts"

_DIGEST_RE: Final = re.compile(r"sha256:[0-9a-f]{64}\Z")
_JOB_ID_RE: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")


class ContainerIdentityError(ValueError):
    """Raised when a Docker inspect payload is not owned by the requested job."""


def _require_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError(f"{label} must be a non-empty string without NUL")
    return value


def _validate_job_id(job_id: object) -> str:
    value = _require_text(job_id, "job_id")
    if _JOB_ID_RE.fullmatch(value) is None or value in {".", ".."}:
        raise ValueError("job_id must be a simple Docker-safe identifier")
    return value


def _validate_image_digest(image_digest: object) -> str:
    value = _require_text(image_digest, "image_digest")
    if _DIGEST_RE.fullmatch(value) is None:
        raise ValueError("image_digest must be an exact lowercase sha256 digest")
    return value


def _absolute_path(value: object, label: str) -> Path:
    if isinstance(value, (str, os.PathLike)):
        raw = os.fspath(value)
    else:
        raise ValueError(f"{label} must be a path")
    if isinstance(raw, bytes):
        raise ValueError(f"{label} must be a text path")
    if not raw or any(character in raw for character in ('\x00', '\n', '\r')):
        raise ValueError(f"{label} must be a non-empty path without NUL")
    lexical_path = Path(raw)
    if not lexical_path.is_absolute():
        raise ValueError(f"{label} must be absolute")
    path = Path(os.path.abspath(raw))
    if os.name == "nt" and str(path).startswith("\\\\"):
        raise ValueError(f"{label} must use a local host path")
    # ``--mount`` uses comma-delimited key/value pairs.  Rejecting a comma is
    # safer than allowing a host path to alter Docker's mount specification.
    if "," in str(path):
        raise ValueError(f"{label} cannot contain a comma")
    # Docker Desktop does not consistently accept the Windows extended-length
    # prefix through the CLI.  Failing closed also avoids two spellings of one
    # host path in identity/receipt code.
    if str(path).startswith("\\\\?\\"):
        raise ValueError(f"{label} must not use an extended Windows path prefix")
    return path


def _is_reparse_or_symlink(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
    except OSError:
        return True

    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction):
        try:
            if is_junction():
                return True
        except OSError:
            return True

    try:
        attributes = os.stat(path, follow_symlinks=False).st_file_attributes
    except (AttributeError, FileNotFoundError, OSError):
        attributes = 0
    reparse_point = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_point)


def _contains_reparse_component(path: Path, stop: Path) -> bool:
    """Check the lexical path before ``resolve`` can hide a link component."""

    current = path
    while True:
        if current == stop:
            return False
        if _is_reparse_or_symlink(current):
            return True
        parent = current.parent
        if parent == current:
            return False
        current = parent


def _resolve_storage_dir(value: object, label: str, storage_root: Path) -> Path:
    path = _absolute_path(value, label)
    try:
        if not path.exists() or not path.is_dir():
            raise ValueError(f"{label} must be an existing directory")
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"cannot resolve {label}") from exc

    try:
        resolved.relative_to(storage_root)
    except ValueError as exc:
        raise ValueError(f"{label} must be under storage_root") from exc
    if resolved == storage_root:
        raise ValueError(f"{label} must not be storage_root itself")
    if _contains_reparse_component(path, storage_root):
        raise ValueError(f"{label} must not contain a symlink or junction")
    return resolved


def _paths_overlap(left: Path, right: Path) -> bool:
    return left == right or left in right.parents or right in left.parents


def _validate_tree_links(root: Path, label: str) -> None:
    """Reject mount contents that traverse outside their own mount root."""

    try:
        walker = os.walk(root, topdown=True, followlinks=False)
        for current, directory_names, file_names in walker:
            current_path = Path(current)
            for name in (*directory_names, *file_names):
                candidate = current_path / name
                if not _is_reparse_or_symlink(candidate):
                    continue
                if not candidate.is_symlink():
                    raise ValueError(f"{label} contains an unsafe reparse point")
                try:
                    target = candidate.resolve(strict=False)
                    target.relative_to(root)
                except (OSError, RuntimeError, ValueError) as exc:
                    raise ValueError(f"{label} contains a symlink escape") from exc
    except OSError as exc:
        raise ValueError(f"cannot inspect {label}") from exc


def _validate_path_scope(
    storage_root_value: object,
    source_value: object,
    build_value: object,
    artifact_value: object,
) -> tuple[Path, Path, Path, Path]:
    storage_lexical = _absolute_path(storage_root_value, "storage_root")
    try:
        if not storage_lexical.exists() or not storage_lexical.is_dir():
            raise ValueError("storage_root must be an existing directory")
        storage_root = storage_lexical.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ValueError("cannot resolve storage_root") from exc
    storage_git_marker = storage_root / ".git"
    if storage_git_marker.exists() or _is_reparse_or_symlink(storage_git_marker):
        raise ValueError("storage_root must not be a Git checkout")

    source = _resolve_storage_dir(source_value, "source_dir", storage_root)
    build = _resolve_storage_dir(build_value, "build_dir", storage_root)
    artifacts = _resolve_storage_dir(artifact_value, "artifact_dir", storage_root)

    if _paths_overlap(source, build) or _paths_overlap(source, artifacts) or _paths_overlap(build, artifacts):
        raise ValueError("source, build, and artifact directories must not overlap")

    _validate_tree_links(source, "source_dir")
    _validate_tree_links(build, "build_dir")
    _validate_tree_links(artifacts, "artifact_dir")

    # A source capsule is not a Git checkout.  This catches accidental mounts
    # of the host checkout even when the caller has supplied a broad storage
    # root around it.
    git_marker = source / ".git"
    if git_marker.exists() or _is_reparse_or_symlink(git_marker):
        raise ValueError("source_dir must be a source capsule, not a Git checkout")

    return storage_root, source, build, artifacts


def _format_cpus(cpus: object) -> str:
    if isinstance(cpus, bool) or not isinstance(cpus, (int, float)):
        raise ValueError("cpus must be a finite number")
    value = float(cpus)
    if not math.isfinite(value) or not MIN_CPUS <= value <= MAX_CPUS:
        raise ValueError(f"cpus must be between {MIN_CPUS} and {MAX_CPUS}")
    formatted = f"{value:.6f}".rstrip("0").rstrip(".")
    return formatted or "0"


def _format_memory(memory_bytes: object) -> str:
    if isinstance(memory_bytes, bool) or not isinstance(memory_bytes, int):
        raise ValueError("memory_bytes must be an integer")
    if not MIN_MEMORY_BYTES <= memory_bytes <= MAX_MEMORY_BYTES:
        raise ValueError(
            f"memory_bytes must be between {MIN_MEMORY_BYTES} and {MAX_MEMORY_BYTES}"
        )
    return str(memory_bytes)


def _bind_mount(source: Path, target: str, *, readonly: bool) -> str:
    # Keep the host spelling intact for Docker Desktop.  In particular, a
    # Windows ``C:\\...`` path belongs in the source value; converting it to a
    # WSL path would silently select a different Docker daemon filesystem.
    return f"type=bind,source={source},target={target}" + (",readonly" if readonly else "")


_TRUSTED_OPERATIONS: Final = frozenset({"verify-source"})


def build_worker_command(
    job_id: str,
    image_digest: str,
    source_dir: str | os.PathLike[str],
    build_dir: str | os.PathLike[str],
    artifact_dir: str | os.PathLike[str],
    *,
    storage_root: str | os.PathLike[str],
    source_digest: str,
    cpus: int | float,
    memory_bytes: int,
    gpu: bool = False,
    operation: str = "verify-source",
) -> list[str]:
    """Return a bounded, non-shell Docker ``argv`` for one worker job.

    The only operation currently admitted is ``verify-source``.  It lowers to
    a diagnostic source check and never to FEM qualification or an arbitrary
    command.
    """

    checked_job_id = _validate_job_id(job_id)
    checked_digest = _validate_image_digest(image_digest)
    if not isinstance(source_digest, str) or re.fullmatch('[a-f0-9]{64}', source_digest) is None:
        raise ValueError('source_digest must be an exact SHA-256')
    if not isinstance(operation, str) or operation not in _TRUSTED_OPERATIONS:
        raise ValueError("operation is not in the trusted worker catalogue")
    if not isinstance(gpu, bool):
        raise ValueError("gpu must be a bool")
    _, source, build, artifacts = _validate_path_scope(
        storage_root,
        source_dir,
        build_dir,
        artifact_dir,
    )
    cpu_arg = _format_cpus(cpus)
    memory_arg = _format_memory(memory_bytes)

    command: list[str] = [
        "docker",
        "run",
        "--init",
        "--name",
        f"fullmag-worker-{checked_job_id}",
        "--label",
        f"{OWNER_LABEL_KEY}={OWNER_LABEL_VALUE}",
        "--label",
        f"{JOB_LABEL_KEY}={checked_job_id}",
        "--read-only",
        "--network",
        "none",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--pids-limit",
        str(MAX_PIDS),
        "--cpus",
        cpu_arg,
        "--memory",
        memory_arg,
        "--memory-swap",
        memory_arg,
        "--tmpfs",
        f"/tmp:rw,nosuid,nodev,noexec,size={TMPFS_SIZE}",
        "--env",
        "HOME=/tmp",
        "--env",
        "TMPDIR=/tmp",
        "--env",
        "PYTHONDONTWRITEBYTECODE=1",
        "--mount",
        _bind_mount(source, SOURCE_MOUNT_TARGET, readonly=True),
        "--mount",
        _bind_mount(build, BUILD_MOUNT_TARGET, readonly=True),
        "--mount",
        _bind_mount(artifacts, ARTIFACT_MOUNT_TARGET, readonly=False),
        "--workdir",
        SOURCE_MOUNT_TARGET,
        "--entrypoint",
        WORKER_ENTRYPOINT,
    ]
    if gpu:
        command.extend(("--gpus", "all"))

    command.extend(
        (
            checked_digest,
            "verify-source",
            "--job-id",
            checked_job_id,
            "--source-digest",
            source_digest,
            "--source",
            SOURCE_MOUNT_TARGET,
            "--build",
            BUILD_MOUNT_TARGET,
            "--artifacts",
            ARTIFACT_MOUNT_TARGET,
        )
    )
    return command


def _inspect_object(payload: object) -> Mapping[str, object] | None:
    if isinstance(payload, Mapping):
        return payload
    if isinstance(payload, Sequence) and not isinstance(payload, (str, bytes, bytearray)):
        if len(payload) != 1 or not isinstance(payload[0], Mapping):
            return None
        return payload[0]
    return None


def _inspect_labels(payload: Mapping[str, object]) -> Mapping[str, object] | None:
    config = payload.get("Config")
    if isinstance(config, Mapping):
        labels = config.get("Labels")
        if isinstance(labels, Mapping):
            return labels
        if labels is not None:
            return None
    labels = payload.get("Labels")
    return labels if isinstance(labels, Mapping) else None


def validate_container_identity(
    inspect_payload: object,
    job_id: str,
    expected_container_id: str | None = None,
    *,
    owner: str = OWNER_LABEL_VALUE,
) -> bool:
    """Return true only for one inspect object owned by this exact job.

    Callers cancelling a container should pass the container ID returned by
    their own persisted lease as ``expected_container_id``.  A missing ID,
    malformed inspect shape, missing labels, label mismatch, or ID mismatch is
    always false; no best-effort/name-only cancellation is allowed.
    """

    try:
        checked_job_id = _validate_job_id(job_id)
        checked_owner = _require_text(owner, "owner")
    except ValueError:
        return False
    if expected_container_id is not None and (
        not isinstance(expected_container_id, str)
        or not expected_container_id
        or "\x00" in expected_container_id
    ):
        return False

    payload = _inspect_object(inspect_payload)
    if payload is None:
        return False
    container_id = payload.get("Id")
    if not isinstance(container_id, str) or not container_id:
        return False
    if expected_container_id is not None and container_id != expected_container_id:
        return False

    labels = _inspect_labels(payload)
    if labels is None:
        return False
    return labels.get(OWNER_LABEL_KEY) == checked_owner and labels.get(JOB_LABEL_KEY) == checked_job_id


def assert_container_identity(
    inspect_payload: object,
    job_id: str,
    expected_container_id: str | None = None,
    *,
    owner: str = OWNER_LABEL_VALUE,
) -> None:
    """Fail closed before a caller issues ``docker stop/rm`` for a job."""

    if expected_container_id is None:
        raise ContainerIdentityError(
            "cancellation requires the exact persisted container ID"
        )
    if not validate_container_identity(
        inspect_payload,
        job_id,
        expected_container_id,
        owner=owner,
    ):
        raise ContainerIdentityError("Docker container identity does not match the requested job")


# Name used by small coordinator adapters that prefer a predicate-style helper.
container_identity_matches = validate_container_identity


__all__ = [
    "ARTIFACT_MOUNT_TARGET",
    "BUILD_MOUNT_TARGET",
    "ContainerIdentityError",
    "JOB_LABEL_KEY",
    "MAX_CPUS",
    "MAX_MEMORY_BYTES",
    "MAX_PIDS",
    "MIN_CPUS",
    "MIN_MEMORY_BYTES",
    "OWNER_LABEL_KEY",
    "OWNER_LABEL_VALUE",
    "SOURCE_MOUNT_TARGET",
    "TMPFS_SIZE",
    "WORKER_ENTRYPOINT",
    "assert_container_identity",
    "build_worker_command",
    "container_identity_matches",
    "validate_container_identity",
]
