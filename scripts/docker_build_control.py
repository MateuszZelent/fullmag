"""Host-side RPC adapter for Fullmag's Docker named-volume build control.

This module never maps a Docker volume to a host path.  The only guest access
is a bounded JSON request over stdin/stdout through an ephemeral Compose
service; build-control data and temporary files stay inside the named volume.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import quote


SCHEMA = "fullmag.docker-build-control.v1"
OWNER_SCHEMA = "fullmag.docker-build-control-owner.v1"
REQUEST_SCHEMA = "fullmag.docker-build-control-request.v1"
RESPONSE_SCHEMA = "fullmag.docker-build-control-response.v1"
ROLE = "control"
VOLUME_PREFIX = "fullmag-build-control-v1-"
VOLUME_DRIVER = "local"
VOLUME_TARGET = "/control"
HELPER_TARGET = "/opt/fullmag/build_control.py"
COMPOSE_FILE = "compose.build-control.yaml"
HELPER_RELATIVE = Path("docker") / "all-in-one" / "build_control.py"

LABEL_SCHEMA = "com.fullmag.build-control.schema"
LABEL_PROJECT = "com.fullmag.build-control.project"
LABEL_WORKTREE = "com.fullmag.build-control.worktree-id"
LABEL_ROLE = "com.fullmag.build-control.role"
LABEL_OWNER = "com.fullmag.build-control.owner-id"
LABEL_CREATION = "com.fullmag.build-control.creation-id"
_LABEL_PREFIX = "com.fullmag.build-control."

MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_RPC_BYTES = 24 * 1024 * 1024
MAX_CAPACITY_BYTES = (1 << 63) - 1
DOCKER_TIMEOUT_SECONDS = 120
DOCKER_CONTEXT = "desktop-linux"

_PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,254}$")
_WORKTREE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_IMAGE_ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_VOLUME_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,127}$")
_CREATION_ID_RE = re.compile(r"^[0-9a-f]{64}$")


class DockerBuildControlError(RuntimeError):
    """Raised when a control volume cannot be proven exact and owned."""


@dataclass(frozen=True)
class FileObservation:
    """Content identity observed in the Docker volume, never a host path."""

    uri: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True)
class VolumeCapacity:
    """Capacity observed from the mounted Docker filesystem."""

    total_bytes: int
    available_bytes: int


DockerRunner = Callable[..., subprocess.CompletedProcess[bytes]]


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DockerBuildControlError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise DockerBuildControlError(f"non-finite JSON number is forbidden: {value}")


def _strict_json_loads(value: bytes | str, *, label: str) -> Any:
    if isinstance(value, bytes):
        try:
            text = value.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise DockerBuildControlError(f"{label} is not UTF-8") from error
    elif isinstance(value, str):
        text = value
    else:
        raise DockerBuildControlError(f"{label} is not text")
    try:
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except json.JSONDecodeError as error:
        raise DockerBuildControlError(f"{label} is not valid JSON") from error


def _canonical_json(value: Any, *, limit: int, label: str) -> bytes:
    try:
        result = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeError) as error:
        raise DockerBuildControlError(f"{label} is not canonical JSON data") from error
    if len(result) > limit:
        raise DockerBuildControlError(f"{label} exceeds the {limit}-byte limit")
    return result


def _safe_component(value: str, label: str, pattern: re.Pattern[str]) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise DockerBuildControlError(f"{label} is not a safe canonical identifier")
    return value


def _source_root(value: str | os.PathLike[str]) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.is_symlink():
        raise DockerBuildControlError("source_root must be an absolute checkout directory")
    try:
        root = path.resolve(strict=True)
    except OSError as error:
        raise DockerBuildControlError("source_root is unavailable") from error
    if not root.is_dir() or root.is_symlink():
        raise DockerBuildControlError("source_root must be a real checkout directory")
    compose_file = root / COMPOSE_FILE
    helper_file = root / HELPER_RELATIVE
    for file_path, label in ((compose_file, "versioned Compose file"), (helper_file, "helper source")):
        if file_path.is_symlink() or not file_path.is_file():
            raise DockerBuildControlError(f"source_root has no regular {label}")
    return root


def _relative_parts(value: str, *, allow_root: bool = False) -> tuple[str, ...]:
    if not isinstance(value, str) or "\x00" in value or "\\" in value or ":" in value:
        raise DockerBuildControlError("path must be a relative POSIX path")
    if value == "" and allow_root:
        return ()
    if not value or value.startswith("/") or value.endswith("/"):
        raise DockerBuildControlError("path must be a non-empty relative POSIX path")
    parts = tuple(value.split("/"))
    try:
        encoded_value = value.encode("utf-8", errors="strict")
        encoded_parts = tuple(part.encode("utf-8", errors="strict") for part in parts)
    except UnicodeEncodeError as error:
        raise DockerBuildControlError("path contains invalid Unicode") from error
    if len(encoded_value) > 4096:
        raise DockerBuildControlError("path exceeds the 4096-byte limit")
    if any(part in {"", ".", ".."} or part.startswith(".fullmag-build-control-") for part in parts):
        raise DockerBuildControlError("path contains a reserved or unsafe component")
    if any(len(part) > 255 for part in encoded_parts):
        raise DockerBuildControlError("path component exceeds the 255-byte limit")
    return parts


def _canonical_identity(project: str, worktree_id: str) -> dict[str, str]:
    return {
        "schema": OWNER_SCHEMA,
        "project": project,
        "worktree_id": worktree_id,
        "role": ROLE,
    }


def volume_identity(project: str, worktree_id: str) -> dict[str, str]:
    """Return deterministic names, labels, and owner identity for one checkout."""

    project = _safe_component(project, "project", _PROJECT_RE)
    worktree_id = _safe_component(worktree_id, "worktree_id", _WORKTREE_RE)
    identity = _canonical_identity(project, worktree_id)
    canonical = _canonical_json(identity, limit=4096, label="volume identity")
    owner_id = hashlib.sha256(canonical).hexdigest()
    digest = hashlib.sha256(b"fullmag.build-control.volume.v1\0" + canonical).hexdigest()[:32]
    volume_name = f"{VOLUME_PREFIX}{digest}"
    if _VOLUME_NAME_RE.fullmatch(volume_name) is None:
        raise DockerBuildControlError("derived volume name is unsafe")
    labels = {
        LABEL_SCHEMA: SCHEMA,
        LABEL_PROJECT: project,
        LABEL_WORKTREE: worktree_id,
        LABEL_ROLE: ROLE,
        LABEL_OWNER: owner_id,
    }
    return {
        "project": project,
        "worktree_id": worktree_id,
        "role": ROLE,
        "schema": SCHEMA,
        "owner_id": owner_id,
        "volume_name": volume_name,
        "labels": labels,
    }


class BuildControlStore:
    """Use one project/worktree-bound Docker named volume as a small data store.

    ``source_root`` is the absolute checkout root containing the versioned
    Compose definition and readonly helper. ``image_id`` must be the immutable
    Docker image ID in ``sha256:<64 lowercase hex>`` form.
    """

    def __init__(
        self,
        project: str,
        worktree_id: str,
        source_root: str | os.PathLike[str],
        image_id: str,
        *,
        _docker_runner: DockerRunner | None = None,
    ) -> None:
        self._identity = volume_identity(project, worktree_id)
        if not isinstance(image_id, str) or _IMAGE_ID_RE.fullmatch(image_id) is None:
            raise DockerBuildControlError("image_id must be a full immutable sha256 image ID")
        self.image_id = image_id
        self.source_root = _source_root(source_root)
        self.compose_file = self.source_root / COMPOSE_FILE
        self.helper_file = self.source_root / HELPER_RELATIVE
        self._docker_runner = _docker_runner or subprocess.run
        self._creation_nonce = secrets.token_hex(32)
        self._creation_id: str | None = None

    @property
    def volume_name(self) -> str:
        return self._identity["volume_name"]

    @property
    def identity(self) -> Mapping[str, Any]:
        """Return a read-only view of the fixed volume identity."""

        return MappingProxyType({
            **self._identity,
            "labels": MappingProxyType(dict(self._identity["labels"])),
        })

    @property
    def labels(self) -> dict[str, str]:
        creation_id = self._creation_id or self._creation_nonce
        return {**self._identity["labels"], LABEL_CREATION: creation_id}

    def _child_environment(self) -> dict[str, str]:
        environment = dict(os.environ)
        environment.pop("DOCKER_CONTEXT", None)
        environment.pop("DOCKER_HOST", None)
        environment.update({
            "FULLMAG_BUILD_CONTROL_SCHEMA": SCHEMA,
            "FULLMAG_BUILD_CONTROL_OWNER_SCHEMA": OWNER_SCHEMA,
            "FULLMAG_BUILD_CONTROL_PROJECT": self._identity["project"],
            "FULLMAG_BUILD_CONTROL_WORKTREE_ID": self._identity["worktree_id"],
            "FULLMAG_BUILD_CONTROL_ROLE": ROLE,
            "FULLMAG_BUILD_CONTROL_OWNER_ID": self._identity["owner_id"],
            "FULLMAG_BUILD_CONTROL_CREATION_ID": self._creation_id or "",
            "FULLMAG_BUILD_CONTROL_VOLUME": self.volume_name,
            "FULLMAG_BUILD_CONTROL_IMAGE_ID": self.image_id,
            "FULLMAG_BUILD_CONTROL_HELPER": str(self.helper_file),
            "FULLMAG_BUILD_CONTROL_UID": "65532",
            "FULLMAG_BUILD_CONTROL_GID": "65532",
        })
        return environment

    def _run(
        self,
        argv: Sequence[str],
        *,
        input_bytes: bytes | None = None,
        timeout: int = DOCKER_TIMEOUT_SECONDS,
    ) -> subprocess.CompletedProcess[bytes]:
        command = list(argv)
        if not command or command[0] != "docker":
            raise DockerBuildControlError("build-control runner only permits Docker CLI commands")
        command[1:1] = ["--context", DOCKER_CONTEXT]
        try:
            result = self._docker_runner(
                command,
                input=input_bytes,
                capture_output=True,
                check=False,
                timeout=timeout,
                env=self._child_environment(),
                cwd=str(self.source_root),
            )
        except subprocess.TimeoutExpired as error:
            raise DockerBuildControlError(
                "Docker command timed out; outcome is unknown and named-volume resources were retained"
            ) from error
        except OSError as error:
            raise DockerBuildControlError("Docker build-control command could not start") from error
        if not isinstance(getattr(result, "returncode", None), int):
            raise DockerBuildControlError("Docker runner returned no exit status")
        return result

    @staticmethod
    def _output_bytes(value: Any, label: str, *, limit: int = 1024 * 1024) -> bytes:
        if isinstance(value, bytes):
            result = value
        elif isinstance(value, str):
            result = value.encode("utf-8", errors="strict")
        else:
            raise DockerBuildControlError(f"Docker {label} is not byte text")
        if len(result) > limit:
            raise DockerBuildControlError(f"Docker {label} exceeds its bounded output limit")
        return result

    def _inspect_volume(self) -> dict[str, Any] | None:
        result = self._run(("docker", "volume", "inspect", "--format", "{{json .}}", self.volume_name))
        if result.returncode != 0:
            stderr = self._output_bytes(result.stderr, "volume inspect stderr", limit=64 * 1024)
            message = stderr.decode("utf-8", errors="replace").casefold()
            if "no such volume" in message or f'volume "{self.volume_name}" not found' in message:
                return None
            raise DockerBuildControlError("Docker could not inspect the exact control volume")
        stdout = self._output_bytes(result.stdout, "volume inspect output", limit=256 * 1024)
        document = _strict_json_loads(stdout, label="Docker volume inspect")
        if not isinstance(document, dict):
            raise DockerBuildControlError("Docker volume inspect is not an object")
        return document

    def _validate_volume(
        self,
        document: Mapping[str, Any],
        *,
        expected_creation_id: str | None = None,
    ) -> str:
        if document.get("Name") != self.volume_name or document.get("Driver") != VOLUME_DRIVER:
            raise DockerBuildControlError("control volume name or driver does not match")
        if document.get("Options") not in (None, {}):
            raise DockerBuildControlError("control volume has unexpected driver options")
        if document.get("Scope") not in (None, "local"):
            raise DockerBuildControlError("control volume is not local")
        labels = document.get("Labels")
        if not isinstance(labels, dict):
            raise DockerBuildControlError("control volume labels do not exactly match its owner")
        creation_id = labels.get(LABEL_CREATION)
        expected_labels = {**self._identity["labels"], LABEL_CREATION: creation_id}
        if (labels != expected_labels or not isinstance(creation_id, str)
                or _CREATION_ID_RE.fullmatch(creation_id) is None):
            raise DockerBuildControlError("control volume labels do not exactly match its owner")
        if expected_creation_id is not None and creation_id != expected_creation_id:
            raise DockerBuildControlError("control volume was created by a concurrent or foreign initializer")
        mountpoint = document.get("Mountpoint")
        if not isinstance(mountpoint, str) or not mountpoint.startswith("/") or "\\" in mountpoint:
            raise DockerBuildControlError("control volume has no canonical Docker mountpoint")
        normalized = PurePosixPath(mountpoint)
        if (normalized == PurePosixPath("/")
                or any(part in {"", ".", ".."} for part in normalized.parts[1:])):
            raise DockerBuildControlError("control volume mountpoint is unsafe")
        lowered = mountpoint.casefold()
        if any(token in lowered for token in ("/run/desktop/mnt/host", "/mnt/c", "/mnt/d")):
            raise DockerBuildControlError("control volume aliases a host build-data path")
        return creation_id

    def _create_volume(self, creation_id: str) -> None:
        argv = ["docker", "volume", "create", "--driver", VOLUME_DRIVER]
        volume_labels = {**self._identity["labels"], LABEL_CREATION: creation_id}
        for key, value in sorted(volume_labels.items()):
            argv.extend(("--label", f"{key}={value}"))
        argv.append(self.volume_name)
        result = self._run(argv)
        if result.returncode != 0:
            raise DockerBuildControlError("Docker could not create the exact control volume")
        stdout = self._output_bytes(result.stdout, "volume create output", limit=4096)
        if stdout.strip().decode("utf-8", errors="strict") != self.volume_name:
            raise DockerBuildControlError("Docker created an unexpected control volume")

    def _compose_run(self, *, root_init: bool = False) -> list[str]:
        argv = [
            "docker", "compose",
            "--project-name", self._identity["project"],
            "--project-directory", str(self.source_root),
            "-f", str(self.compose_file),
            "run", "--rm", "--no-deps", "-T",
        ]
        if root_init:
            argv.extend(("--user", "0:0", "--cap-add", "CHOWN"))
        argv.append("build-control")
        return argv

    def _rpc(
        self,
        operation: str,
        fields: Mapping[str, Any] | None = None,
        *,
        root_init: bool = False,
    ) -> dict[str, Any]:
        if self._creation_id is None:
            raise DockerBuildControlError("control volume creation identity has not been verified")
        request = {
            "schema": REQUEST_SCHEMA,
            "operation": operation,
            "identity": {
                "project": self._identity["project"],
                "worktree_id": self._identity["worktree_id"],
                "role": ROLE,
                "owner_id": self._identity["owner_id"],
                "creation_id": self._creation_id,
                "volume_name": self.volume_name,
            },
        }
        if fields:
            request.update(fields)
        encoded = _canonical_json(request, limit=MAX_RPC_BYTES, label="helper request")
        result = self._run(self._compose_run(root_init=root_init), input_bytes=encoded)
        if result.returncode != 0:
            stderr = self._output_bytes(result.stderr, "helper stderr", limit=64 * 1024)
            detail = stderr.decode("utf-8", errors="replace").strip().splitlines()
            suffix = f": {detail[-1][:400]}" if detail else ""
            raise DockerBuildControlError(f"build-control helper rejected {operation}{suffix}")
        stdout = self._output_bytes(result.stdout, "helper response", limit=MAX_RPC_BYTES)
        response = _strict_json_loads(stdout, label="build-control helper response")
        if not isinstance(response, dict):
            raise DockerBuildControlError("build-control helper response is not an object")
        if (response.get("schema") != RESPONSE_SCHEMA or response.get("ok") is not True
                or response.get("operation") != operation or set(response) != {"schema", "ok", "operation", "result"}):
            raise DockerBuildControlError("build-control helper response identity is invalid")
        result_document = response.get("result")
        if not isinstance(result_document, dict):
            raise DockerBuildControlError("build-control helper response has no result object")
        return result_document

    def _prepare_volume(self) -> None:
        document = self._inspect_volume()
        created = document is None
        if created:
            self._creation_id = self._creation_nonce
            self._create_volume(self._creation_nonce)
            document = self._inspect_volume()
        if document is None:
            raise DockerBuildControlError("control volume disappeared during initialization")
        self._creation_id = self._validate_volume(
            document,
            expected_creation_id=self._creation_nonce if created else None,
        )
        if created:
            initialized = self._rpc("initialize", root_init=True)
            if (initialized.get("owner_id") != self._identity["owner_id"]
                    or initialized.get("creation_id") != self._creation_id
                    or initialized.get("uid") != 65532 or initialized.get("gid") != 65532):
                raise DockerBuildControlError("new control volume returned the wrong owner marker")

    def ensure(self) -> dict[str, str]:
        """Create this exact labeled volume if absent, then verify its owner marker."""

        self._prepare_volume()
        verified = self._rpc("verify")
        if (verified.get("owner_id") != self._identity["owner_id"]
                or verified.get("creation_id") != self._creation_id
                or verified.get("uid") != 65532 or verified.get("gid") != 65532):
            raise DockerBuildControlError("control volume owner marker or UID is invalid")
        if self._creation_id is None:
            raise DockerBuildControlError("control volume creation identity was not established")
        return {
            "schema": SCHEMA,
            "project": self._identity["project"],
            "worktree_id": self._identity["worktree_id"],
            "role": ROLE,
            "volume_name": self.volume_name,
            "owner_id": self._identity["owner_id"],
            "creation_id": self._creation_id,
        }

    def _path_uri(self, relative_path: str) -> str:
        parts = _relative_parts(relative_path)
        suffix = "/".join(quote(part, safe="-._~") for part in parts)
        return f"docker-volume://{self.volume_name}/{suffix}"

    @staticmethod
    def _observation(result: Mapping[str, Any], uri: str) -> FileObservation:
        size = result.get("size_bytes")
        digest = result.get("sha256")
        if (not isinstance(size, int) or isinstance(size, bool) or size < 0 or size > MAX_FILE_BYTES
                or not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None):
            raise DockerBuildControlError("helper returned an invalid content observation")
        return FileObservation(uri=uri, size_bytes=size, sha256=digest)

    def write_json(self, relative_path: str, document: Any) -> FileObservation:
        uri = self._path_uri(relative_path)
        encoded = _canonical_json(document, limit=MAX_JSON_BYTES, label="JSON document")
        self._prepare_volume()
        result = self._rpc("write_json", {"relative_path": relative_path, "document": document})
        observation = self._observation(result, uri)
        expected_sha = hashlib.sha256(encoded).hexdigest()
        if observation.sha256 != expected_sha or observation.size_bytes != len(encoded):
            raise DockerBuildControlError("helper JSON write observation does not match the request")
        return observation

    def read_json(self, relative_path: str) -> Any:
        self._path_uri(relative_path)
        self._prepare_volume()
        result = self._rpc("read_json", {"relative_path": relative_path})
        document = result.get("document")
        encoded = _canonical_json(document, limit=MAX_JSON_BYTES, label="stored JSON document")
        observation = self._observation(result, self._path_uri(relative_path))
        if observation.sha256 != hashlib.sha256(encoded).hexdigest() or observation.size_bytes != len(encoded):
            raise DockerBuildControlError("helper JSON read observation does not match the stored document")
        return document

    def write_bytes(self, relative_path: str, data: bytes | bytearray | memoryview) -> FileObservation:
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise DockerBuildControlError("write_bytes expects a bytes-like value")
        content = bytes(data)
        if len(content) > MAX_FILE_BYTES:
            raise DockerBuildControlError(f"binary document exceeds the {MAX_FILE_BYTES}-byte limit")
        uri = self._path_uri(relative_path)
        encoded = base64.b64encode(content).decode("ascii")
        self._prepare_volume()
        result = self._rpc("write_bytes", {"relative_path": relative_path, "data_base64": encoded})
        observation = self._observation(result, uri)
        if observation.sha256 != hashlib.sha256(content).hexdigest() or observation.size_bytes != len(content):
            raise DockerBuildControlError("helper binary write observation does not match the request")
        return observation

    def read_bytes(self, relative_path: str) -> bytes:
        self._path_uri(relative_path)
        self._prepare_volume()
        result = self._rpc("read_bytes", {"relative_path": relative_path})
        encoded = result.get("data_base64")
        if not isinstance(encoded, str):
            raise DockerBuildControlError("helper binary read returned no base64 content")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise DockerBuildControlError("helper binary read returned invalid base64") from error
        if len(content) > MAX_FILE_BYTES:
            raise DockerBuildControlError("helper binary read exceeded the file-size limit")
        observation = self._observation(result, self._path_uri(relative_path))
        if observation.sha256 != hashlib.sha256(content).hexdigest() or observation.size_bytes != len(content):
            raise DockerBuildControlError("helper binary read observation does not match its content")
        return content

    def stat(self, relative_path: str) -> FileObservation | None:
        uri = self._path_uri(relative_path)
        self._prepare_volume()
        result = self._rpc("stat", {"relative_path": relative_path})
        if result == {"exists": False}:
            return None
        if result.get("exists") is not True:
            raise DockerBuildControlError("helper returned an invalid stat result")
        return self._observation(result, uri)

    def capacity(self) -> VolumeCapacity:
        """Read total and unprivileged-available bytes for the control volume."""

        self._prepare_volume()
        result = self._rpc("capacity")
        total = result.get("total_bytes")
        available = result.get("available_bytes")
        if (type(total) is not int or type(available) is not int
                or total <= 0 or total > MAX_CAPACITY_BYTES
                or available < 0 or available > total):
            raise DockerBuildControlError("helper returned invalid volume capacity bounds")
        return VolumeCapacity(total_bytes=total, available_bytes=available)

    def uri(self, relative_path: str) -> str:
        """Return the deterministic logical URI without inspecting or mutating Docker."""

        return self._path_uri(relative_path)


__all__ = [
    "BuildControlStore",
    "DockerBuildControlError",
    "FileObservation",
    "VolumeCapacity",
    "OWNER_SCHEMA",
    "ROLE",
    "SCHEMA",
    "volume_identity",
]
