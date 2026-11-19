"""Prepare and attest the native Docker Desktop host-ledger adapter.

The resolver owns Windows paths.  This adapter only translates those paths for a
verified Linux Docker daemon, freezes the versioned maintenance overlay, and
keeps every Docker mutation bounded by an owned container name and receipt.
"""
from __future__ import annotations

from contextlib import nullcontext
import hashlib
import json
import ntpath
import os
import re
import stat
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping

import fullmag_storage as storage

SCHEMA = "fullmag.docker-host-ledger-layout.v1"
RECEIPT_SCHEMA = "fullmag.docker-host-ledger-adapter-receipt.v1"
HOST_RECEIPT_SCHEMA = "fullmag.host-ledger-receipt.v1"
PROFILE = storage.HOST_LEDGER_PROFILE
IMAGE_NAME = storage.HOST_LEDGER_IMAGE_NAME
IMAGE_SIZE_BYTES = storage.HOST_LEDGER_SIZE_BYTES
MOUNT_TARGET = "/host-ledger"
LEDGER_ROOT = "/host-ledger/ledger"
DAEMON_HOST_PREFIX = "/run/desktop/mnt/host"
COMPOSE_SOURCE_NAME = "compose.host-ledger.source.yaml"
COMPOSE_MAINTENANCE_NAME = "compose.host-ledger.maintenance.json"
HELPER_COPY_NAME = "docker_host_ledger.sh"
MAX_HELPER_BYTES = 256 * 1024
MAX_COMPOSE_BYTES = 256 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
_PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
_IMAGE_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_WINDOWS_ABS_RE = re.compile(r"^[A-Za-z]:[\\/].*")


class HostLedgerError(RuntimeError):
    """A fail-closed host-ledger adapter error."""


class DockerInvocationUnknown(HostLedgerError):
    """The Docker callable failed after its side effect boundary was entered."""

    def __init__(self, args: tuple[str, ...], timeout: int, cause: TypeError) -> None:
        self.operation = list(args)
        self.timeout_seconds = timeout
        super().__init__(
            "Docker callable raised TypeError; outcome is unknown and no retry is allowed: "
            f"{cause}"
        )


def _text(value: Any, field: str) -> str:
    if isinstance(value, Path):
        value = str(value)
    if not isinstance(value, str) or not value or "\x00" in value:
        raise HostLedgerError(f"{field} must be a non-empty string without NUL")
    return value


def _safe_project_id(value: Any) -> str:
    value = _text(value, "host-ledger project id")
    if not _PROJECT_RE.fullmatch(value):
        raise HostLedgerError(f"invalid host-ledger project id: {value!r}")
    return value


def _safe_image_id(value: Any) -> str:
    value = _text(value, "image id")
    if not _IMAGE_RE.fullmatch(value):
        raise HostLedgerError("a full immutable image ID is required")
    return value


def _raw_path(value: Any, field: str) -> str:
    raw = _text(value, field)
    if "\r" in raw or "\n" in raw:
        raise HostLedgerError(f"{field} contains a newline")
    return raw


def _reject_dot_components(raw: str, field: str) -> None:
    if raw.startswith("\\\\") or raw.startswith("//"):
        raise HostLedgerError(f"{field} must not use a UNC or double-leading path")
    pieces = raw.replace("\\", "/").split("/")
    if any(part in {".", ".."} for part in pieces):
        raise HostLedgerError(f"{field} contains a dot path component")


def _local_normalized(raw: str) -> str:
    if _WINDOWS_ABS_RE.fullmatch(raw):
        return ntpath.normcase(ntpath.normpath(raw.replace("/", "\\")))
    return os.path.normcase(os.path.abspath(raw))


def _daemon_path(value: Any, field: str) -> str:
    """Translate a local Windows path to the Docker Desktop Linux namespace.

    Existing daemon paths are accepted verbatim after lexical validation.  A
    Windows drive is translated only after the caller has proven the daemon is
    Linux; callers must not use this function before `_daemon_info` succeeds.
    """
    raw = _raw_path(value, field)
    _reject_dot_components(raw, field)
    if _WINDOWS_ABS_RE.fullmatch(raw):
        drive = raw[0].lower()
        tail = raw[2:].replace("\\", "/")
        tail = tail.lstrip("/")
        if not tail:
            raise HostLedgerError(f"{field} cannot be a drive root")
        return f"{DAEMON_HOST_PREFIX}/{drive}/{tail}"
    if raw.startswith(DAEMON_HOST_PREFIX + "/"):
        return str(PurePosixPath(raw))
    if raw.startswith("/"):
        # Linux callers already operate in the daemon namespace.  Native
        # Windows paths never take this branch.
        return str(PurePosixPath(raw))
    raise HostLedgerError(f"{field} must be absolute: {raw}")


def _same_daemon_path(left: Any, right: Any) -> bool:
    try:
        return _daemon_path(left, "left") == _daemon_path(right, "right")
    except HostLedgerError:
        return False


def _owned_path(path: Path, field: str) -> Path:
    try:
        resolved = storage.absolute(Path(path), field)
    except storage.StorageError as error:
        raise HostLedgerError(str(error)) from error
    if storage.is_link(resolved):
        raise HostLedgerError(f"{field} must not be a symlink or reparse point: {resolved}")
    return resolved


def _read_owned_bytes(path: Path, maximum: int, field: str) -> bytes:
    path = _owned_path(path, field)
    if os.name == "nt":
        try:
            from windows_folder_host import read_owned_regular

            return read_owned_regular(path, maximum)
        except (OSError, ValueError) as error:
            raise HostLedgerError(f"{field} could not be read without following a reparse point") from error
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise HostLedgerError(f"{field} could not be opened without following a link") from error
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > maximum:
            raise HostLedgerError(f"{field} is not a bounded regular file")
        with os.fdopen(fd, "rb") as stream:
            fd = -1
            data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise HostLedgerError(f"{field} exceeds its bounded size")
        return data
    finally:
        if fd != -1:
            os.close(fd)


def _regular_file(path: Path, field: str, maximum: int) -> Path:
    path = _owned_path(Path(path), field)
    if not path.is_file():
        raise HostLedgerError(f"{field} must be a regular non-symlink file: {path}")
    size = path.stat().st_size
    if size <= 0 or size > maximum:
        raise HostLedgerError(f"{field} exceeds its bounded size: {path}")
    return path


def _digest(path: Path, maximum: int | None = None) -> str:
    path = _regular_file(path, "managed file", maximum or 64 * 1024 * 1024)
    return hashlib.sha256(
        _read_owned_bytes(path, maximum or 64 * 1024 * 1024, "managed file")
    ).hexdigest()


def _atomic_bytes(path: Path, data: bytes, mode: int = 0o600) -> None:
    path = _owned_path(Path(path), "managed output")
    parent = _owned_path(path.parent, "managed output parent")
    parent.mkdir(parents=True, exist_ok=True)
    parent = _owned_path(parent, "managed output parent")
    if os.name == "nt":
        from windows_folder_host import _pinned_no_reparse_ancestors

        guard = _pinned_no_reparse_ancestors(parent)
    else:
        guard = nullcontext()
    with guard:
        path = _owned_path(path, "managed output")
        temporary = path.with_name(f".{path.name}.tmp.{os.getpid()}")
        temporary = _owned_path(temporary, "managed output temporary")
        if temporary.exists():
            raise HostLedgerError(f"temporary receipt path already exists: {temporary}")
        nofollow = getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, mode)
        try:
            with os.fdopen(fd, "wb") as stream:
                fd = -1
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            # Recheck every managed path immediately before publication.  Native
            # Windows uses the existing write-through replacement helper rather
            # than duplicating Win32 move code in this adapter.
            _owned_path(path.parent, "managed output parent")
            _owned_path(temporary, "managed output temporary")
            _owned_path(path, "managed output")
            if os.name == "nt":
                from windows_folder_host import _replace_write_through

                _replace_write_through(temporary, path)
            else:
                os.replace(temporary, path)
        except BaseException:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            raise


def _atomic_json(path: Path, value: Mapping[str, Any]) -> None:
    _atomic_bytes(Path(path), (json.dumps(value, sort_keys=True, indent=2) + "\n").encode(), 0o600)


def _copy_immutable(source: Path, destination: Path, maximum: int, mode: int) -> str:
    """Freeze a helper/overlay without replacing an existing destination."""
    source = _regular_file(Path(source), "source helper/overlay", maximum)
    source_bytes = _read_owned_bytes(source, maximum, "source helper/overlay")
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    destination = _owned_path(Path(destination), "owned frozen destination")
    parent = _owned_path(destination.parent, "owned frozen destination parent")
    parent.mkdir(parents=True, exist_ok=True)
    parent = _owned_path(parent, "owned frozen destination parent")
    if os.name == "nt":
        from windows_folder_host import _pinned_no_reparse_ancestors

        guard = _pinned_no_reparse_ancestors(parent)
    else:
        guard = nullcontext()
    with guard:
        destination = _owned_path(destination, "owned frozen destination")
        if destination.exists():
            try:
                existing = _read_owned_bytes(destination, maximum, "owned frozen destination")
            except HostLedgerError as error:
                raise HostLedgerError(
                    f"owned frozen file is not a bounded regular file: {destination}"
                ) from error
            if hashlib.sha256(existing).hexdigest() != source_hash:
                raise HostLedgerError(f"owned frozen file differs from source: {destination}")
        else:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            try:
                fd = os.open(destination, flags, mode)
            except FileExistsError as error:
                raise HostLedgerError(
                    f"owned frozen destination appeared during exclusive creation: {destination}"
                ) from error
            try:
                with os.fdopen(fd, "wb") as target_stream:
                    fd = -1
                    target_stream.write(source_bytes)
                    target_stream.flush()
                    os.fsync(target_stream.fileno())
            finally:
                if fd != -1:
                    os.close(fd)
            # This is a handle-based no-follow read on native Windows and an
            # O_NOFOLLOW read on POSIX; it catches a replacement before the
            # frozen file becomes usable.
            if _read_owned_bytes(destination, maximum, "owned frozen destination") != source_bytes:
                raise HostLedgerError(
                    f"owned frozen destination changed while being written: {destination}"
                )
        _owned_path(destination, "owned frozen destination")
        # The native writer sets the mode at O_EXCL creation.  Do not chmod an
        # existing Windows path after the no-reparse read: that API has no
        # pinned directory handle and a late junction swap must never reach a
        # target.  POSIX can apply the mode without following a symlink.
        if os.name != "nt":
            os.chmod(destination, mode, follow_symlinks=False)
    return source_hash


def _within(path: Any, parent: Any) -> bool:
    raw_path = _raw_path(path, "path")
    raw_parent = _raw_path(parent, "parent")
    windows_path = bool(_WINDOWS_ABS_RE.fullmatch(raw_path))
    if windows_path != bool(_WINDOWS_ABS_RE.fullmatch(raw_parent)):
        return False
    try:
        if windows_path:
            candidate = ntpath.normcase(ntpath.normpath(raw_path.replace("/", "\\")))
            root = ntpath.normcase(ntpath.normpath(raw_parent.replace("/", "\\")))
            return ntpath.commonpath([candidate, root]) == root
        candidate = _local_normalized(raw_path)
        root = _local_normalized(raw_parent)
        return os.path.commonpath([candidate, root]) == root
    except (OSError, ValueError):
        return False


def _layout_value(layout: Mapping[str, Any], name: str, env_name: str | None = None) -> Any:
    if name in layout and layout[name] not in (None, ""):
        return layout[name]
    values = layout.get("env")
    if isinstance(values, Mapping) and env_name and values.get(env_name) not in (None, ""):
        return values[env_name]
    return None


def _resolve_values(layout: Mapping[str, Any]) -> dict[str, str]:
    if not isinstance(layout, Mapping):
        raise HostLedgerError("resolved storage layout must be a mapping")
    project_id = _layout_value(layout, "host_ledger_project_id", "FULLMAG_HOST_LEDGER_PROJECT_ID")
    if project_id is None:
        project_id = _layout_value(layout, "project_id", "FULLMAG_PROJECT_ID")
    if project_id is None:
        project_root = _layout_value(layout, "project_root")
        if project_root is None:
            raise HostLedgerError("resolved layout has no project identity")
        project_id = storage.identifier(project_root)
    project_id = _safe_project_id(project_id)

    storage_root = _layout_value(layout, "storage_root", "FULLMAG_PROJECT_STORAGE_ROOT")
    if storage_root is None:
        raise HostLedgerError("resolved layout has no canonical storage root")
    storage_root = _raw_path(storage_root, "storage root")
    if storage_root in {"/", "\\", "C:\\", "c:\\"}:
        raise HostLedgerError("host-ledger storage root cannot be a filesystem root")
    backing = _layout_value(layout, "host_ledger_backing_image", "FULLMAG_HOST_LEDGER_BACKING_IMAGE")
    expected_backing = ntpath.join(storage_root, "build-volumes", IMAGE_NAME) if _WINDOWS_ABS_RE.fullmatch(storage_root) else os.path.join(storage_root, "build-volumes", IMAGE_NAME)
    backing = _raw_path(backing or expected_backing, "host-ledger backing image")
    if _local_normalized(backing) != _local_normalized(expected_backing):
        raise HostLedgerError("host-ledger backing image is not under canonical storage/build-volumes")

    mount = _layout_value(layout, "host_ledger_mount_root", "FULLMAG_HOST_LEDGER_MOUNT_ROOT")
    expected_mount = f"/mnt/fullmag-host-ledger-{project_id}"
    mount = _raw_path(mount or expected_mount, "host-ledger mount root")
    if mount != expected_mount:
        raise HostLedgerError("host-ledger mount root is not project-scoped")
    lock = _layout_value(layout, "host_ledger_lock_path", "FULLMAG_HOST_LEDGER_LOCK_PATH")
    expected_lock = backing + ".lock"
    lock = _raw_path(lock or expected_lock, "host-ledger lock path")
    if _local_normalized(lock) != _local_normalized(expected_lock):
        raise HostLedgerError("host-ledger lock path is not next to the canonical image")
    marker = _layout_value(layout, "host_ledger_owner_marker", "FULLMAG_HOST_LEDGER_OWNER_MARKER")
    expected_marker = mount + "/.fullmag-host-ledger-owner.json"
    marker = _raw_path(marker or expected_marker, "host-ledger owner marker")
    if marker != expected_marker:
        raise HostLedgerError("host-ledger owner marker is not under the project mount")
    return {
        "project_id": project_id,
        "storage_root": storage_root,
        "backing_image": backing,
        "mount_root": mount,
        "lock_path": lock,
        "owner_marker": marker,
        "ledger_root": LEDGER_ROOT,
        "ledger_root_daemon": mount + "/ledger",
    }


def _capture(value: Any) -> tuple[str, str, str]:
    """Normalize the injected Docker callable result without leaking secrets."""
    if isinstance(value, subprocess.CompletedProcess):
        stdout = value.stdout or ""
        stderr = value.stderr or ""
        if value.returncode != 0:
            detail = str(stderr or stdout).strip()
            raise HostLedgerError(
                f"Docker operation returned exit code {value.returncode}: {detail[-4096:]}"
            )
        return str(stdout), str(stderr), str(stdout) + str(stderr)
    if isinstance(value, Mapping):
        returncode = value.get("returncode")
        if returncode is not None:
            if isinstance(returncode, bool) or not isinstance(returncode, int):
                raise HostLedgerError("Docker operation returned an invalid exit code")
            if returncode != 0:
                detail = str(value.get("stderr") or value.get("stdout") or "").strip()
                raise HostLedgerError(
                    f"Docker operation returned exit code {returncode}: {detail[-4096:]}"
                )
        stdout = str(value.get("stdout") or "")
        stderr = str(value.get("stderr") or "")
        combined = str(value.get("combined") or (stdout + stderr))
        return stdout, stderr, combined
    if isinstance(value, tuple) and len(value) == 2:
        stdout, stderr = (str(value[0] or ""), str(value[1] or ""))
        return stdout, stderr, stdout + stderr
    text = "" if value is None else str(value)
    return text, "", text


def _invoke(docker_callable: Callable[..., Any], *args: str, timeout: int = 60,
            environment: Mapping[str, str] | None = None) -> tuple[str, str, str]:
    kwargs: dict[str, Any] = {"combined": True, "timeout": timeout}
    if environment is not None:
        kwargs["environment"] = dict(environment)
    try:
        value = docker_callable(*args, **kwargs)
    except TypeError as error:
        # The callable may have entered Docker before raising TypeError.  A
        # compatibility retry could duplicate a privileged mutation or lose
        # the exact environment, so preserve the outcome as unknown.
        raise DockerInvocationUnknown(tuple(args), timeout, error) from error
    return _capture(value)


def _unknown(error: BaseException) -> bool:
    return isinstance(error, (TimeoutError, subprocess.TimeoutExpired)) or (
        hasattr(error, "operation") and hasattr(error, "timeout_seconds")
    )


def _daemon_info(
    docker_callable: Callable[..., Any], *, include_capacity: bool = False
) -> dict[str, Any]:
    stdout, stderr, combined = _invoke(docker_callable, "info", "--format", "{{json .}}", timeout=30)
    text = stdout.strip() or combined.strip()
    try:
        document = json.loads(text)
    except (ValueError, TypeError):
        if include_capacity:
            raise HostLedgerError("Docker info did not return JSON capacity fields")
        fields = text.split("|", 1)
        document = {"ID": fields[0].strip(), "OSType": fields[1].strip() if len(fields) == 2 else ""}
    if not isinstance(document, Mapping):
        raise HostLedgerError("Docker info did not return an object")
    daemon_id = str(document.get("ID") or "").strip()
    os_type = str(document.get("OSType") or "").strip().lower()
    if not daemon_id or "\n" in daemon_id or os_type != "linux":
        raise HostLedgerError("host-ledger requires a verified Linux Docker daemon with a non-empty ID")
    result: dict[str, Any] = {
        "id_sha256": hashlib.sha256(daemon_id.encode("utf-8")).hexdigest(),
        "os_type": os_type,
    }
    if include_capacity:
        cpu_count = document.get("NCPU")
        memory_total_bytes = document.get("MemTotal")
        if type(cpu_count) is not int or cpu_count <= 0:
            raise HostLedgerError("Docker info CPU count is missing or invalid")
        if type(memory_total_bytes) is not int or memory_total_bytes <= 0:
            raise HostLedgerError("Docker info memory total is missing or invalid")
        result.update(cpu_count=cpu_count, memory_total_bytes=memory_total_bytes)
    return result


def _image_attestation(image_id: str, docker_callable: Callable[..., Any]) -> dict[str, Any]:
    stdout, _, combined = _invoke(docker_callable, "image", "inspect", image_id, timeout=60)
    try:
        document = json.loads(stdout or combined)
        observed = document[0] if isinstance(document, list) and len(document) == 1 else document
    except (ValueError, TypeError, IndexError) as error:
        raise HostLedgerError("Docker image inspect did not return one image") from error
    if not isinstance(observed, Mapping) or observed.get("Id") != image_id:
        raise HostLedgerError("maintenance image identity differs from the immutable requested image")
    if (observed.get("Config") or {}).get("Volumes"):
        raise HostLedgerError("maintenance image declares anonymous volumes")
    return {"id": image_id, "created": observed.get("Created"), "repo_tags": observed.get("RepoTags", [])}


def _parse_json_lines(text: str, schema: str) -> dict[str, Any] | None:
    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise HostLedgerError(f"JSON receipt for {schema} has duplicate keys")
            value[key] = item
        return value

    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line.startswith("{") or not line.endswith("}"):
            continue
        try:
            value = json.loads(line, object_pairs_hook=reject_duplicate_keys)
        except HostLedgerError:
            raise
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("schema") == schema:
            return value
    return None


def _inspect_container(name: str, docker_callable: Callable[..., Any]) -> dict[str, Any]:
    stdout, _, combined = _invoke(docker_callable, "inspect", name, timeout=60)
    try:
        value = json.loads(stdout or combined)
    except ValueError as error:
        raise HostLedgerError(f"Docker inspect for owned container {name!r} was not JSON") from error
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise HostLedgerError(f"Docker inspect for owned container {name!r} was ambiguous")
    return value[0]


def _owned_terminal(document: Mapping[str, Any], *, name: str, image_id: str,
                    label_key: str, label_value: str) -> bool:
    if document.get("Name") != "/" + name:
        return False
    if document.get("Image") != image_id:
        return False
    labels = document.get("Config", {}).get("Labels") or {}
    if labels.get(label_key) != label_value:
        return False
    state = document.get("State") or {}
    return state.get("Status") == "exited" and int(state.get("ExitCode", -1)) >= 0


def _remove_owned(document: Mapping[str, Any], *, name: str, image_id: str,
                  label_key: str, label_value: str,
                  docker_callable: Callable[..., Any]) -> None:
    if not _owned_terminal(document, name=name, image_id=image_id, label_key=label_key, label_value=label_value):
        raise HostLedgerError(f"refusing to remove unverified container {name!r}")
    _invoke(docker_callable, "rm", name, timeout=60)


def _write_output(run_root: Path, prefix: str, stdout: str, stderr: str, combined: str) -> None:
    for suffix, value in (("stdout.log", stdout), ("stderr.log", stderr), ("output.log", combined)):
        if len(value.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
            value = value.encode("utf-8", "replace")[:MAX_OUTPUT_BYTES].decode("utf-8", "replace")
        _atomic_bytes(run_root / f"{prefix}.{suffix}", value.encode("utf-8"), 0o600)


def _validate_host_receipt(value: Mapping[str, Any], values: Mapping[str, str]) -> None:
    required = (
        "schema", "profile", "state", "project_id", "backing_image", "mount_root",
        "ledger_root", "mount_target", "filesystem", "filesystem_uuid",
        "image_size_bytes", "loop_device", "mount_active",
    )
    if not isinstance(value, Mapping) or any(value.get(key) in (None, "") for key in required):
        raise HostLedgerError("host-ledger maintenance receipt is incomplete")
    if value.get("schema") != HOST_RECEIPT_SCHEMA or value.get("profile") != PROFILE:
        raise HostLedgerError("host-ledger maintenance receipt schema/profile mismatch")
    if value.get("state") not in {"ready", "validated"} or value.get("filesystem") != "ext4":
        raise HostLedgerError("host-ledger maintenance did not report a validated ext4 filesystem")
    if value.get("mount_active") is not True or value.get("mount_root") != values.get("mount_root"):
        raise HostLedgerError("host-ledger maintenance did not leave the expected mount active")
    expected_project = values.get("project_id")
    if expected_project and value.get("project_id") != expected_project:
        raise HostLedgerError("host-ledger receipt project identity differs from the resolved project")
    if value.get("backing_image") != values.get("backing_image"):
        raise HostLedgerError("host-ledger receipt identity does not match the resolved backing image")
    if value.get("ledger_root") != str(values.get("mount_root")) + "/ledger":
        raise HostLedgerError("host-ledger receipt ledger child differs from the resolved mount")
    if value.get("mount_target") != MOUNT_TARGET or value.get("image_size_bytes") != IMAGE_SIZE_BYTES:
        raise HostLedgerError("host-ledger receipt resource contract mismatch")
    filesystem_uuid = value.get("filesystem_uuid")
    if not isinstance(filesystem_uuid, str) or not re.fullmatch(r"[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}", filesystem_uuid):
        raise HostLedgerError("host-ledger receipt filesystem UUID is invalid")
    loop_device = value.get("loop_device")
    if not isinstance(loop_device, str) or not re.fullmatch(r"/dev/loop[0-9]+", loop_device):
        raise HostLedgerError("host-ledger receipt loop device is invalid")
    if not isinstance(value.get("image_size_bytes"), int) or isinstance(value.get("image_size_bytes"), bool):
        raise HostLedgerError("host-ledger receipt image size is invalid")
    if "created_image" in value and not isinstance(value["created_image"], bool):
        raise HostLedgerError("host-ledger receipt created_image flag is invalid")
    if "qualification" in value and value["qualification"] != "storage-admission-only":
        raise HostLedgerError("host-ledger receipt qualification is invalid")


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise HostLedgerError(f"JSON object has duplicate key: {key}")
        value[key] = item
    return value


def _parse_json_document(text: str, field: str) -> Any:
    try:
        return json.loads(text, object_pairs_hook=_reject_duplicate_json_keys)
    except HostLedgerError:
        raise
    except (UnicodeError, ValueError, TypeError) as error:
        raise HostLedgerError(f"{field} is not valid JSON") from error


def _expected_maintenance_environment(environment: Mapping[str, str]) -> dict[str, str]:
    names = (
        "FULLMAG_HOST_LEDGER_PROFILE", "FULLMAG_HOST_LEDGER_PROJECT_ID",
        "FULLMAG_HOST_LEDGER_STORAGE_ROOT", "FULLMAG_HOST_LEDGER_BACKING_IMAGE",
        "FULLMAG_HOST_LEDGER_MOUNT_ROOT", "FULLMAG_HOST_LEDGER_LOCK_PATH",
        "FULLMAG_HOST_LEDGER_OWNER_MARKER", "FULLMAG_HOST_LEDGER_SIZE_BYTES",
        "FULLMAG_HOST_LEDGER_MOUNT_TARGET", "FULLMAG_HOST_LEDGER_LEDGER_ROOT",
        "FULLMAG_HOST_LEDGER_HOST_PID", "FULLMAG_HOST_LEDGER_RUNTIME_UID",
        "FULLMAG_HOST_LEDGER_RUNTIME_GID", "FULLMAG_HOST_LEDGER_LOCK_WAIT_SECONDS",
    )
    expected = {name: environment.get(name) for name in names}
    expected.update({
        "FULLMAG_DOCKER_HOST_ID": environment.get("FULLMAG_DOCKER_HOST_ID", ""),
        "FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY": environment.get(
            "FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY", "0"
        ),
        "FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT": environment.get(
            "FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT", ""
        ),
        "FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES": environment.get(
            "FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES", ""
        ),
    })
    if any(not isinstance(value, str) or not value for name, value in expected.items()
           if name not in {
               "FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT",
               "FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES",
           }):
        raise HostLedgerError("maintenance environment is incomplete")
    publish = expected["FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY"]
    if publish not in {"0", "1"}:
        raise HostLedgerError("maintenance capacity publication flag is invalid")
    if publish == "1":
        if re.fullmatch(r"[0-9a-f]{64}", expected["FULLMAG_DOCKER_HOST_ID"]) is None:
            raise HostLedgerError("maintenance capacity daemon identity is invalid")
        for key in (
            "FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT",
            "FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES",
        ):
            value = expected[key]
            if not isinstance(value, str) or not value.isdecimal() or int(value) <= 0:
                raise HostLedgerError(f"maintenance capacity input is invalid: {key}")
    elif (expected["FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT"]
          or expected["FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES"]):
        raise HostLedgerError("legacy maintenance environment has unexpected capacity inputs")
    return expected


def _validate_maintenance_service(
    service: Mapping[str, Any], *, environment: Mapping[str, str], image_id: str
) -> None:
    if service.get("image") != image_id:
        raise HostLedgerError("maintenance image did not resolve to the immutable image ID")
    expected_scalars = {
        "profiles": ["host-ledger-maintenance"],
        "user": "0:0",
        "privileged": True,
        "pid": "host",
        "network_mode": "none",
        "restart": "no",
        "read_only": True,
        "entrypoint": ["/bin/bash", "/usr/local/sbin/docker_host_ledger.sh"],
        "command": ["ensure"],
    }
    for key, expected in expected_scalars.items():
        if service.get(key) != expected:
            raise HostLedgerError(f"maintenance service contract differs at {key}")
    allowed_service_keys = {
        "command", "entrypoint", "environment", "image", "network_mode", "pid", "cgroup",
        "profiles", "privileged", "read_only", "restart", "user", "volumes",
    }
    if set(service) - allowed_service_keys:
        raise HostLedgerError("maintenance service has an unsupported Compose field")
    if service.get("environment") != _expected_maintenance_environment(environment):
        raise HostLedgerError("maintenance service environment differs from the resolved contract")
    publish_capacity = environment.get("FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY", "0") == "1"
    if (publish_capacity and service.get("cgroup") != "host"
            or not publish_capacity and service.get("cgroup", "private") != "private"):
        raise HostLedgerError("maintenance cgroup namespace differs from its capacity scope")

    volumes = service.get("volumes")
    if not isinstance(volumes, list) or len(volumes) != 3:
        raise HostLedgerError("maintenance service must have exactly three controlled bind mounts")
    expected_volumes = {
        "/usr/local/sbin/docker_host_ledger.sh": (
            environment["FULLMAG_HOST_LEDGER_HELPER_PATH"], True, False
        ),
        environment["FULLMAG_HOST_LEDGER_STORAGE_ROOT"]: (
            environment["FULLMAG_HOST_LEDGER_STORAGE_ROOT"], False, False
        ),
        environment["FULLMAG_HOST_LEDGER_MOUNT_ROOT"]: (
            environment["FULLMAG_HOST_LEDGER_MOUNT_ROOT"], False, True
        ),
    }
    seen_targets: set[str] = set()
    for volume in volumes:
        if not isinstance(volume, Mapping):
            raise HostLedgerError("maintenance bind mount is not an object")
        allowed = {"type", "source", "target", "read_only", "bind"}
        if set(volume) - allowed:
            raise HostLedgerError("maintenance bind mount has unsupported fields")
        target = volume.get("target")
        if not isinstance(target, str) or target in seen_targets or target not in expected_volumes:
            raise HostLedgerError("maintenance bind mount target is not controlled")
        seen_targets.add(target)
        expected_source, expected_read_only, create_host_path = expected_volumes[target]
        if volume.get("type") != "bind" or not _same_daemon_path(volume.get("source"), expected_source):
            raise HostLedgerError(f"maintenance bind mount source differs at {target}")
        if "read_only" not in volume:
            actual_read_only = False
        else:
            actual_read_only = volume["read_only"]
            if not isinstance(actual_read_only, bool):
                raise HostLedgerError(f"maintenance bind mount mode is not boolean at {target}")
        if actual_read_only is not expected_read_only:
            raise HostLedgerError(f"maintenance bind mount mode differs at {target}")
        bind = volume.get("bind")
        if not isinstance(bind, Mapping) or set(bind) - {"create_host_path"}:
            raise HostLedgerError(f"maintenance bind options differ at {target}")
        if "create_host_path" not in bind:
            actual_create_host_path = True
        else:
            actual_create_host_path = bind["create_host_path"]
            if not isinstance(actual_create_host_path, bool):
                raise HostLedgerError(f"maintenance bind creation policy is not boolean at {target}")
        if actual_create_host_path is not create_host_path:
            raise HostLedgerError(f"maintenance bind creation policy differs at {target}")
    if seen_targets != set(expected_volumes):
        raise HostLedgerError("maintenance bind mount set is incomplete")


def _validate_overlay_config(document: Mapping[str, Any], environment: Mapping[str, str]) -> None:
    """Require the backend to carry the daemon identity used by the receipt."""
    services = document.get("services")
    if not isinstance(services, Mapping):
        raise HostLedgerError("resolved host-ledger overlay has no services mapping")
    backend = services.get("backend")
    if not isinstance(backend, Mapping):
        raise HostLedgerError("resolved host-ledger overlay has no backend service")
    backend_environment = backend.get("environment")
    if not isinstance(backend_environment, Mapping):
        raise HostLedgerError("host-ledger backend environment is not a mapping")
    expected = environment.get("FULLMAG_DOCKER_HOST_ID")
    if not isinstance(expected, str) or re.fullmatch(r"[0-9a-f]{64}", expected) is None:
        raise HostLedgerError("resolved Docker daemon identity is not a SHA-256 digest")
    if backend_environment.get("FULLMAG_DOCKER_HOST_ID") != expected:
        raise HostLedgerError("host-ledger backend Docker daemon identity differs from the resolved daemon")



def _render_maintenance(
    source: Path,
    destination: Path,
    *,
    environment: Mapping[str, str],
    image_id: str,
    docker_callable: Callable[..., Any],
) -> None:
    """Resolve the versioned overlay with Compose, then retain maintenance only.

    The source deliberately contains an incomplete backend service.  Compose is
    therefore the only supported resolver for interpolation, short syntax and
    defaults; a host YAML parser would produce a different contract and adds a
    dependency that the operator image does not install.
    """
    source = _regular_file(source, "host-ledger Compose overlay", MAX_COMPOSE_BYTES)
    values = dict(environment)
    values["FULLMAG_HOST_LEDGER_HELPER_IMAGE"] = image_id
    stdout, _, combined = _invoke(
        docker_callable,
        "compose",
        "-f",
        str(source),
        "--profile",
        "host-ledger-maintenance",
        "config",
        "--format",
        "json",
        "--no-consistency",
        timeout=60,
        environment=values,
    )
    rendered = stdout.strip() or combined.strip()
    if len(rendered.encode("utf-8", "replace")) > MAX_COMPOSE_BYTES:
        raise HostLedgerError("resolved host-ledger Compose overlay exceeds its bound")
    document = _parse_json_document(rendered, "Docker Compose host-ledger overlay")
    if not isinstance(document, dict) or not isinstance(document.get("services"), dict):
        raise HostLedgerError("resolved host-ledger Compose overlay has no services mapping")
    services = document["services"]
    if set(services) != {"backend", "host-ledger-maintenance"}:
        raise HostLedgerError("host-ledger overlay service topology changed")
    _validate_overlay_config(document, values)
    maintenance = services["host-ledger-maintenance"]
    if not isinstance(maintenance, dict):
        raise HostLedgerError("resolved maintenance service is not an object")
    _validate_maintenance_service(maintenance, environment=values, image_id=image_id)

    _atomic_json(destination, {"services": {"host-ledger-maintenance": maintenance}})
    # Validate the frozen, standalone file with normal Compose consistency
    # checks.  The incomplete backend is absent at this point, so no bypass is
    # needed for this final validation.
    _invoke(
        docker_callable,
        "compose",
        "-f",
        str(destination),
        "--profile",
        "host-ledger-maintenance",
        "config",
        "--quiet",
        timeout=60,
        environment=values,
    )


def _container_name(prefix: str, run_root: Path) -> str:
    token = re.sub(r"[^a-z0-9_.-]", "-", run_root.name.lower()).strip(".-")
    if not token:
        raise HostLedgerError("run root has no safe identity")
    value = f"fullmag-host-ledger-{prefix}-{token}"
    if len(value) > 63:
        value = value[:63].rstrip(".-")
    return value


def _run_owned_container(*, args: list[str], name: str, image_id: str, label_value: str,
                         run_root: Path, prefix: str, docker_callable: Callable[..., Any],
                         timeout: int) -> tuple[dict[str, Any], dict[str, Any]]:
    label_key = "org.fullmag.host-ledger.owner"
    try:
        stdout, stderr, combined = _invoke(docker_callable, *args, timeout=timeout)
        _write_output(run_root, prefix, stdout, stderr, combined)
    except BaseException as error:
        _write_output(run_root, prefix, "", str(error), str(error))
        if _unknown(error):
            raise
        # A normal non-zero run may still have created a terminal container;
        # inspect it before deciding whether removal is safe.
        try:
            document = _inspect_container(name, docker_callable)
            if _owned_terminal(document, name=name, image_id=image_id, label_key=label_key, label_value=label_value):
                _remove_owned(document, name=name, image_id=image_id, label_key=label_key, label_value=label_value, docker_callable=docker_callable)
        except BaseException:
            pass
        raise
    document = _inspect_container(name, docker_callable)
    if not _owned_terminal(document, name=name, image_id=image_id, label_key=label_key, label_value=label_value):
        raise HostLedgerError(f"owned maintenance container {name!r} did not terminate in a verifiable state")
    state = document["State"]
    if int(state.get("ExitCode", -1)) != 0:
        raise HostLedgerError(f"owned maintenance container {name!r} exited with {state.get('ExitCode')}")
    output = _parse_json_lines(_capture((stdout, stderr))[2], HOST_RECEIPT_SCHEMA)
    if output is None:
        try:
            # Capture daemon logs while the owned terminal container still
            # exists.  Removing it first makes this fallback impossible.
            _, _, logs = _invoke(docker_callable, "logs", name, timeout=60)
            output = _parse_json_lines(logs, HOST_RECEIPT_SCHEMA)
        except BaseException:
            output = None
    _remove_owned(document, name=name, image_id=image_id, label_key=label_key, label_value=label_value, docker_callable=docker_callable)
    return document, output or {}


def _probe_host_python(run_root: Path, image_id: str, docker_callable: Callable[..., Any], receipt: dict[str, Any]) -> None:
    name = _container_name("python", run_root)
    # Maintenance executes Python in the image and accesses the daemon mount
    # namespace through /proc/1/root; LinuxKit does not ship a full Python stdlib.
    script = (
        "set -eu; command -v nsenter >/dev/null; nsenter -t 1 -m -- true; "
        "/usr/local/bin/python3 -I -c 'import encodings, os, stat; "
        'assert stat.S_ISDIR(os.stat("/proc/1/root").st_mode); '
        'print("fullmag-host-ledger-host-python3-v1")' + "'"
    )
    receipt["host_python_probe_scope"] = "image-python-accesses-host-root"
    receipt["host_python_probe_interpreter"] = "/usr/local/bin/python3"

    label_key = "org.fullmag.host-ledger.owner"
    args = ["run", "--name", name, "--user", "0:0", "--privileged", "--pid", "host", "--network", "none",
            "--read-only", "--entrypoint", "/bin/sh", "--label", f"{label_key}={receipt['run_id']}", image_id, "-c", script]
    receipt["host_python_probe_container"] = name
    try:
        document, _ = _run_owned_container(args=args, name=name, image_id=image_id, label_value=receipt["run_id"],
                                            run_root=run_root, prefix="host-python", docker_callable=docker_callable,
                                            timeout=120)
        receipt["host_python_probe_state"] = document.get("State", {}).get("Status")
        stdout = _read_owned_bytes(
            run_root / "host-python.stdout.log", MAX_OUTPUT_BYTES, "host python probe output"
        ).decode("utf-8", "replace")
        if "fullmag-host-ledger-host-python3-v1" not in stdout:
            raise HostLedgerError("host namespace python3 probe did not return its marker")
        receipt["host_python_probe"] = "PASS"
    except BaseException:
        receipt["host_python_probe"] = "UNKNOWN" if _unknown(sys.exc_info()[1]) else "FAIL"
        raise


def _run_maintenance(run_root: Path, compose_file: Path, image_id: str, project: str,
                     action: str, docker_callable: Callable[..., Any], receipt: dict[str, Any],
                     timeout: int) -> dict[str, Any]:
    name = _container_name(action, run_root)
    label_value = receipt["run_id"]
    label_key = "org.fullmag.host-ledger.owner"
    args = ["compose", "--project-name", project, "--profile", "host-ledger-maintenance", "-f", str(compose_file),
            "run", "--name", name, "--label", f"{label_key}={label_value}", "host-ledger-maintenance", action]
    receipt[f"{action}_container"] = name
    document, host_receipt = _run_owned_container(args=args, name=name, image_id=image_id, label_value=label_value,
                                                   run_root=run_root, prefix=f"maintenance-{action}",
                                                   docker_callable=docker_callable, timeout=timeout)
    values = {
        "project_id": receipt.get("project_id"),
        "mount_root": receipt["mount_root"],
        "backing_image": receipt["backing_image"],
    }
    _validate_host_receipt(host_receipt, values)
    receipt[f"{action}_container_state"] = document.get("State", {}).get("Status")
    receipt[f"{action}_receipt"] = host_receipt
    return host_receipt


def prepare(layout: Mapping[str, Any], repo: Any, image_id: str, run_root: Any,
            docker_callable: Callable[..., Any]) -> dict[str, Any]:
    """Prepare one persistent host-ledger mount and return launcher bindings."""
    image_id = _safe_image_id(image_id)
    values = _resolve_values(layout)
    repo = Path(repo)
    run_root = Path(run_root)
    if not repo.is_absolute() or not run_root.is_absolute():
        raise HostLedgerError("repo and run_root must be absolute paths")
    runs_root = _layout_value(layout, "runs_root")
    if runs_root is not None and not _within(run_root, runs_root):
        raise HostLedgerError("host-ledger run root is outside the resolved runs root")
    # Resolve and inspect the existing ancestor chain before creating any
    # run-owned files.  Native Windows callers additionally recheck each file
    # through the no-reparse reader before it is consumed.
    run_root = _owned_path(run_root, "host-ledger run root")
    _owned_path(run_root.parent, "host-ledger run root parent")
    run_root.mkdir(parents=True, exist_ok=True)
    helper_source = repo / "scripts" / "lib" / HELPER_COPY_NAME
    overlay_source = repo / "compose.host-ledger.yaml"
    helper_copy = run_root / HELPER_COPY_NAME
    overlay_copy = run_root / COMPOSE_SOURCE_NAME
    helper_hash = _copy_immutable(helper_source, helper_copy, MAX_HELPER_BYTES, 0o444)
    overlay_hash = _copy_immutable(overlay_source, overlay_copy, MAX_COMPOSE_BYTES, 0o444)
    daemon_info = _daemon_info(docker_callable)
    image_attestation = _image_attestation(image_id, docker_callable)

    environment = {
        "FULLMAG_HOST_LEDGER_PROFILE": PROFILE,
        "FULLMAG_HOST_LEDGER_PROJECT_ID": values["project_id"],
        "FULLMAG_HOST_LEDGER_STORAGE_ROOT": _daemon_path(values["storage_root"], "storage root"),
        "FULLMAG_HOST_LEDGER_BACKING_IMAGE": _daemon_path(values["backing_image"], "backing image"),
        "FULLMAG_HOST_LEDGER_MOUNT_ROOT": values["mount_root"],
        "FULLMAG_HOST_LEDGER_LOCK_PATH": _daemon_path(values["lock_path"], "lock path"),
        "FULLMAG_HOST_LEDGER_OWNER_MARKER": values["owner_marker"],
        "FULLMAG_HOST_LEDGER_SIZE_BYTES": str(IMAGE_SIZE_BYTES),
        "FULLMAG_HOST_LEDGER_MOUNT_TARGET": MOUNT_TARGET,
        "FULLMAG_HOST_LEDGER_ROOT": LEDGER_ROOT,
        "FULLMAG_HOST_LEDGER_LEDGER_ROOT": values["ledger_root_daemon"],
        "FULLMAG_HOST_LEDGER_HELPER_PATH": _daemon_path(helper_copy, "helper copy"),
        "FULLMAG_HOST_LEDGER_HELPER_IMAGE": image_id,
        "FULLMAG_HOST_LEDGER_HOST_PID": "1",
        "FULLMAG_HOST_LEDGER_RUNTIME_UID": "65532",
        "FULLMAG_HOST_LEDGER_RUNTIME_GID": "65532",
        "FULLMAG_HOST_LEDGER_LOCK_WAIT_SECONDS": "120",
        "FULLMAG_DOCKER_HOST_ID": daemon_info["id_sha256"],
    }
    run_id = hashlib.sha256(str(run_root).encode("utf-8")).hexdigest()[:32]
    receipt_path = run_root / "host-ledger-adapter-receipt.json"
    if receipt_path.is_symlink() or receipt_path.exists():
        raise HostLedgerError("an existing host-ledger receipt requires explicit reconciliation; refusing retry")
    receipt: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA,
        "state": "starting",
        "run_id": run_id,
        "profile": PROFILE,
        "project_id": values["project_id"],
        "image_id": image_id,
        "image": image_attestation,
        "docker_daemon_id_sha256": daemon_info["id_sha256"],
        "docker_ostype": daemon_info["os_type"],
        "storage_root": environment["FULLMAG_HOST_LEDGER_STORAGE_ROOT"],
        "backing_image": environment["FULLMAG_HOST_LEDGER_BACKING_IMAGE"],
        "mount_root": values["mount_root"],
        "ledger_root": LEDGER_ROOT,
        "ledger_root_daemon": values["ledger_root_daemon"],
        "helper_source": str(helper_source),
        "helper_copy": str(helper_copy),
        "helper_sha256": helper_hash,
        "compose_source": str(overlay_copy),
        "compose_source_sha256": overlay_hash,
        "receipt_path": str(receipt_path),
    }
    _atomic_json(receipt_path, receipt)
    try:
        maintenance_doc = run_root / COMPOSE_MAINTENANCE_NAME
        _render_maintenance(
            overlay_copy,
            maintenance_doc,
            environment=environment,
            image_id=image_id,
            docker_callable=docker_callable,
        )
        receipt["maintenance_compose"] = str(maintenance_doc)
        receipt["maintenance_compose_sha256"] = _digest(maintenance_doc, MAX_COMPOSE_BYTES)
        _atomic_json(receipt_path, receipt)
        _probe_host_python(run_root, image_id, docker_callable, receipt)
        _atomic_json(receipt_path, receipt)
        project = f"fullmag-host-ledger-{run_root.name}"
        host_receipt = _run_maintenance(run_root, maintenance_doc, image_id, project, "ensure", docker_callable, receipt, 300)
        _validate_host_receipt(host_receipt, {
            "project_id": values["project_id"],
            "mount_root": values["mount_root"],
            "backing_image": environment["FULLMAG_HOST_LEDGER_BACKING_IMAGE"],
        })
        receipt["state"] = "ready"
        receipt["host_receipt"] = host_receipt
        receipt["environment"] = environment
        _atomic_json(receipt_path, receipt)
    except BaseException as error:
        receipt["state"] = "outcome_unknown" if _unknown(error) else "failed_resources_retained"
        receipt["error"] = str(error)
        receipt["resources_retained"] = True
        _atomic_json(receipt_path, receipt)
        raise
    return {
        "schema": SCHEMA,
        "profile": PROFILE,
        "state": "ready",
        "run_id": run_id,
        "project_id": values["project_id"],
        "image_id": image_id,
        "environment": environment,
        "mount_root": values["mount_root"],
        "ledger_root": LEDGER_ROOT,
        "ledger_root_daemon": values["ledger_root_daemon"],
        "backing_image": environment["FULLMAG_HOST_LEDGER_BACKING_IMAGE"],
        "backing_image_local": values["backing_image"],
        "compose_overlay": str(overlay_copy),
        "maintenance_compose": str(run_root / COMPOSE_MAINTENANCE_NAME),
        "run_root": str(run_root),
        "helper_copy": str(helper_copy),
        "helper_sha256": helper_hash,
        "compose_source_sha256": overlay_hash,
        "receipt": str(receipt_path),
        "receipt_sha256": _digest(receipt_path),
        "host_receipt": host_receipt,
        "docker_daemon_id_sha256": daemon_info["id_sha256"],
    }


def backend_verify_command(container: str) -> list[str]:
    """Return the bounded guest-side write/root check used after API startup."""
    container = _text(container, "backend container")
    return ["exec", container, "/bin/sh", "-ceu",
            "test -d /host-ledger/ledger; test ! -L /host-ledger/ledger; test -w /host-ledger/ledger"]


def _env_map(config: Mapping[str, Any]) -> dict[str, str]:
    values = {}
    for item in config.get("Env", []) or []:
        if isinstance(item, str) and "=" in item:
            key, value = item.split("=", 1)
            values[key] = value
    return values


HOST_VOLUME_PROBE_FUNCTIONS = r'''
import ctypes, json, os, re, stat, uuid

def _ledger_statfs_type(root):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.statfs.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
    libc.statfs.restype = ctypes.c_int
    result = ctypes.create_string_buffer(256)
    if libc.statfs(os.fsencode(root), result) != 0:
        raise OSError(ctypes.get_errno(), 'cannot inspect ledger filesystem')
    return ctypes.c_long.from_buffer(result).value

def _ledger_loop_device(loop):
    if not isinstance(loop, str) or not re.fullmatch(r'/dev/loop[0-9]+', loop):
        raise ValueError('ledger loop device is invalid')
    # One exact known sysfs attribute, never a device/host directory scan.
    with open('/sys/block/' + loop.rsplit('/', 1)[1] + '/dev', 'rb') as stream:
        value = stream.read(65)
    if len(value) > 64 or not re.fullmatch(rb'[0-9]+:[0-9]+\n?', value):
        raise ValueError('ledger loop sysfs identity is invalid')
    return tuple(int(part) for part in value.strip().split(b':'))

def _ledger_nofollow_stat(path):
    if not path.startswith('/') or path.startswith('//') or any(part in {'.', '..'} for part in path.split('/')):
        raise ValueError('ledger probe path is unsafe')
    current = '/'
    for component in path.strip('/').split('/'):
        current = current.rstrip('/') + '/' + component
        value = os.lstat(current)
        if stat.S_ISLNK(value.st_mode):
            raise ValueError('ledger probe path traverses a symlink')
    return value

def _ledger_marker(path):
    before = _ledger_nofollow_stat(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(descriptor)
        if ((before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
                or not stat.S_ISREG(opened.st_mode) or opened.st_uid != 0 or opened.st_gid != 0
                or stat.S_IMODE(opened.st_mode) != 0o444 or opened.st_nlink != 1
                or not 0 < opened.st_size <= 16384):
            raise ValueError('ledger owner marker ownership/type/size differs')
        data = os.read(descriptor, 16385)
        after = os.fstat(descriptor)
        if (len(data) != opened.st_size or (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise ValueError('ledger owner marker changed during read')
    finally:
        os.close(descriptor)
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('ledger owner marker repeats a key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs), opened

def probe(descriptor, root='/host-ledger'):
    if os.geteuid() != 65532 or os.getegid() != 65532:
        raise ValueError('ledger probe must run as the fixed unprivileged runtime identity')
    if not os.statvfs(root).f_flag & os.ST_RDONLY:
        raise ValueError('ledger probe requires a read-only consumer mount')
    if not isinstance(descriptor, dict) or descriptor.get('schema') != 'fullmag.host-ledger-volume.v2':
        raise ValueError('ledger probe requires the exact v2 descriptor')
    expected = descriptor['host_receipt']
    loop = descriptor['loop_device']
    alias = descriptor['device_alias']
    if descriptor.get('options') != {'type': 'ext4', 'o': 'rw', 'device': alias}:
        raise ValueError('ledger probe driver options differ')
    if any(expected.get(key) != descriptor.get(key)
           for key in ('project_id', 'mount_root', 'backing_image', 'filesystem_uuid', 'loop_device')):
        raise ValueError('ledger probe receipt identity differs')
    if alias != '/dev/disk/by-uuid/' + descriptor['filesystem_uuid']:
        raise ValueError('ledger probe requires the stable UUID device')
    if expected.get('image_size_bytes') != 134217728 or expected.get('filesystem') != 'ext4':
        raise ValueError('ledger probe filesystem contract differs')
    root_info = _ledger_nofollow_stat(root)
    ledger_info = _ledger_nofollow_stat(root + '/ledger')
    if (not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != 0 or root_info.st_gid != 0
            or stat.S_IMODE(root_info.st_mode) != 0o755):
        raise ValueError('ledger volume root ownership/mode differs')
    if (not stat.S_ISDIR(ledger_info.st_mode) or ledger_info.st_uid != 65532 or ledger_info.st_gid != 65532
            or stat.S_IMODE(ledger_info.st_mode) != 0o770 or ledger_info.st_dev != root_info.st_dev):
        raise ValueError('ledger runtime directory ownership/device/mode differs')
    device = (os.major(root_info.st_dev), os.minor(root_info.st_dev))
    if device != _ledger_loop_device(loop) or _ledger_statfs_type(root) != 0xef53:
        raise ValueError('ledger volume is not the exact loop ext4 filesystem')
    marker, marker_info = _ledger_marker(root + '/.fullmag-host-ledger-owner.json')
    fields = {'schema', 'profile', 'project_id', 'backing_image', 'mount_root', 'filesystem_uuid',
              'image_size_bytes', 'mount_target', 'runtime_uid', 'runtime_gid', 'owner_token'}
    checks = {'schema': 'fullmag.host-ledger-owner.v1', 'profile': 'host-ledger-v1',
              'project_id': descriptor['project_id'], 'backing_image': descriptor['backing_image'],
              'mount_root': descriptor['mount_root'], 'filesystem_uuid': descriptor['filesystem_uuid'],
              'image_size_bytes': 134217728, 'mount_target': '/host-ledger',
              'runtime_uid': 65532, 'runtime_gid': 65532}
    if (not isinstance(marker, dict) or set(marker) != fields or marker_info.st_dev != root_info.st_dev
            or any(type(marker.get(key)) is not type(value) or marker.get(key) != value for key, value in checks.items())):
        raise ValueError('ledger owner marker canonical identity differs')
    token = uuid.UUID(marker['owner_token'])
    if token.int == 0 or str(token) != marker['owner_token']:
        raise ValueError('ledger owner token is not canonical')
    return {'schema': 'fullmag.host-ledger-volume-probe.v1', 'state': 'verified',
            'volume_name': descriptor['name'], 'project_id': descriptor['project_id'],
            'backing_image': descriptor['backing_image'], 'mount_root': descriptor['mount_root'],
            'filesystem_uuid': descriptor['filesystem_uuid'], 'loop_device': loop, 'device_alias': alias,
            'device_major': device[0], 'device_minor': device[1],
            'root_inode': root_info.st_ino, 'ledger_inode': ledger_info.st_ino,
            'owner_token': marker['owner_token'], 'read_only': True}
'''

HOST_VOLUME_PROBE = HOST_VOLUME_PROBE_FUNCTIONS + "\nimport signal, sys\nsignal.alarm(45)\nprint(json.dumps(probe(json.loads(sys.argv[1])), sort_keys=True))\n"


def host_volume_probe_spec(descriptor: Mapping[str, Any], image: str) -> dict[str, Any]:
    """Return a bounded read-only consumer; the caller owns its lifecycle/logs."""
    image = _safe_image_id(image)
    if not isinstance(descriptor, Mapping):
        raise HostLedgerError("ledger volume probe requires a canonical descriptor")
    expected = host_volume_descriptor(descriptor.get("compose_project"), descriptor.get("project_id"),
        descriptor.get("mount_root"), descriptor.get("host_receipt"))
    if descriptor != expected:
        raise HostLedgerError("ledger volume probe descriptor identity differs")
    mount = {**descriptor["mount"], "read_only": True}
    service = {"image": image, "pull_policy": "never", "user": "65532:65532",
        "network_mode": "none", "privileged": False, "read_only": True,
        "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"],
        "pids_limit": 32, "mem_limit": "128m", "cpus": 0.25, "restart": "no",
        "environment": {"NVIDIA_VISIBLE_DEVICES": "void", "PYTHONDONTWRITEBYTECODE": "1"},
        "entrypoint": ["/usr/local/bin/python3", "-B", "-c"],
        "command": [HOST_VOLUME_PROBE, json.dumps(descriptor, sort_keys=True, separators=(",", ":"))],
        "volumes": [mount]}
    return {"name": descriptor["compose_project"], "services": {"host-ledger-volume-probe": service},
        "volumes": {"host-ledger": dict(descriptor["compose_volume"])}}


def host_volume_descriptor(compose_project: str, project_id: str, mount_root: str,
                           host_receipt: Mapping[str, Any]) -> dict[str, Any]:
    """Describe a local-driver mount of the exact already-owned ext4 UUID.

    Docker Desktop mount namespaces need not expose the maintenance mountpoint.
    Its stable UUID path prevents a reused raw loop number mounting foreign data.
    The immutable descriptor retains its original receipt; later verification
    compares stable device/filesystem identity without rewriting that receipt.
    """
    project = _text(compose_project, "Compose project")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        raise HostLedgerError("host-ledger volume requires a valid Compose project")
    project_id = _safe_project_id(project_id)
    if mount_root != "/mnt/fullmag-host-ledger-" + project_id:
        raise HostLedgerError("host-ledger volume device differs from the canonical project mount")
    if not isinstance(host_receipt, Mapping):
        raise HostLedgerError("host-ledger volume requires its canonical maintenance receipt")
    _validate_host_receipt(host_receipt, {"project_id": project_id, "mount_root": mount_root,
        "backing_image": host_receipt.get("backing_image")})
    backing = _daemon_path(host_receipt["backing_image"], "host-ledger backing image")
    if (backing != host_receipt["backing_image"]
            or not backing.endswith("/build-volumes/" + IMAGE_NAME)):
        raise HostLedgerError("host-ledger volume backing image is not canonical")
    filesystem_uuid, loop = host_receipt["filesystem_uuid"], host_receipt["loop_device"]
    alias = "/dev/disk/by-uuid/" + filesystem_uuid
    if host_receipt.get("device_alias", alias) != alias:
        raise HostLedgerError("host-ledger volume requires the canonical UUID device alias")
    identity = json.dumps([project, project_id, mount_root, backing, filesystem_uuid, alias], separators=(",", ":")).encode()
    name = "fullmag-host-ledger-ext4-v2-" + hashlib.sha256(identity).hexdigest()[:24]
    labels = {"org.fullmag.host-ledger.volume.schema": "fullmag.host-ledger-volume.v2",
        "org.fullmag.host-ledger.project-id": project_id,
        "org.fullmag.host-ledger.mount-root": mount_root,
        "org.fullmag.host-ledger.backing-image": backing,
        "org.fullmag.host-ledger.filesystem-uuid": filesystem_uuid,
        "org.fullmag.host-ledger.device-alias": alias,
        "com.docker.compose.project": project,
        "com.docker.compose.volume": "host-ledger"}
    return {"schema": "fullmag.host-ledger-volume.v2", "name": name,
        "compose_project": project, "project_id": project_id, "mount_root": mount_root,
        "host_receipt": dict(host_receipt), "backing_image": backing,
        "filesystem_uuid": filesystem_uuid, "loop_device": loop, "device_alias": alias,
        "driver": "local", "options": {"type": "ext4", "o": "rw", "device": alias},
        "labels": labels,
        "compose_volume": {"name": name, "external": True},
        "mount": {"type": "volume", "source": "host-ledger", "target": MOUNT_TARGET,
                  "volume": {"nocopy": True}}}


def _validate_host_volume(document: Any, descriptor: Mapping[str, Any]) -> Mapping[str, Any]:
    if isinstance(document, list):
        if len(document) != 1:
            raise HostLedgerError("host-ledger volume inspect is ambiguous; existing data retained")
        document = document[0]
    if not isinstance(document, Mapping):
        raise HostLedgerError("host-ledger volume inspect is not an object; existing data retained")
    labels = document.get("Labels")
    if (document.get("Name") != descriptor["name"]
            or document.get("Driver") != "local" or document.get("Scope") != "local"
            or document.get("Options") != descriptor["options"]
            or not isinstance(labels, Mapping)
            or any(labels.get(key) != value
                   for key, value in descriptor["labels"].items())):
        raise HostLedgerError("host-ledger volume ownership/driver/device differs; existing data retained")
    mountpoint = document.get("Mountpoint")
    if (not isinstance(mountpoint, str) or not mountpoint.startswith("/") or mountpoint == "/"
            or any(ord(char) < 32 or ord(char) == 127 for char in mountpoint)
            or _daemon_path(mountpoint, "host-ledger volume mountpoint") != mountpoint):
        raise HostLedgerError("host-ledger volume mountpoint is invalid; existing data retained")
    return document


def prepare_host_volume(profile: Mapping[str, Any], compose_project: str,
                        docker_callable: Callable[..., Any]) -> dict[str, Any]:
    """Admit/create only the exact descriptor after the daemon mount is ensured."""
    _validate_host_receipt(profile.get("host_receipt"), {"project_id": profile.get("project_id"),
        "mount_root": profile.get("mount_root"), "backing_image": profile.get("backing_image")})
    descriptor = host_volume_descriptor(compose_project, profile.get("project_id"),
        profile.get("mount_root"), profile["host_receipt"])
    output, _, combined = _invoke(docker_callable, "volume", "ls", "--format", "{{.Name}}", timeout=30)
    names = (output or combined).splitlines()
    if descriptor["name"] not in names:
        arguments = ["volume", "create", "--driver", "local"]
        for key, value in descriptor["options"].items():
            arguments.extend(["--opt", key + "=" + value])
        for key, value in descriptor["labels"].items():
            arguments.extend(["--label", key + "=" + value])
        _invoke(docker_callable, *arguments, descriptor["name"], timeout=60)
    output, _, combined = _invoke(docker_callable, "volume", "inspect", descriptor["name"], timeout=30)
    _validate_host_volume(json.loads(output or combined), descriptor)
    return descriptor


def validate_container(document: Mapping[str, Any] | list[Mapping[str, Any]], profile: Mapping[str, Any] | str,
                       docker_callable: Callable[..., Any]) -> dict[str, Any]:
    """Attest backend binds and perform a live guest + host filesystem check."""
    if isinstance(document, list):
        if len(document) != 1:
            raise HostLedgerError("backend inspect result is ambiguous")
        document = document[0]
    if not isinstance(document, Mapping):
        raise HostLedgerError("backend inspect document must be an object")
    if isinstance(profile, str):
        expected_profile = profile
        profile_values: Mapping[str, Any] = {"profile": profile}
    else:
        profile_values = profile
        expected_profile = profile.get("profile", PROFILE)
    if expected_profile != PROFILE:
        raise HostLedgerError("unexpected host-ledger profile")
    actual = document
    container_id = str(actual.get("Id") or actual.get("ID") or "")
    if not container_id:
        raise HostLedgerError("backend inspect has no container ID")
    config = actual.get("Config") or {}
    expected_image = profile_values.get("image_id")
    if expected_image and actual.get("Image") != expected_image:
        raise HostLedgerError("backend image differs from the immutable host-ledger image")
    env = _env_map(config)
    if env.get("FULLMAG_HOST_LEDGER_PROFILE") != PROFILE or env.get("FULLMAG_HOST_LEDGER_ROOT") != LEDGER_ROOT:
        raise HostLedgerError("backend did not receive the fixed host-ledger profile/root")
    if env.get("FULLMAG_DOCKER_HOST_EXECUTION") != "1":
        raise HostLedgerError("backend host execution flag is missing")
    expected_env = profile_values.get("environment") or {}
    for key in ("FULLMAG_HOST_LEDGER_MOUNT_ROOT", "FULLMAG_HOST_LEDGER_PROJECT_ID", "FULLMAG_DOCKER_HOST_ID"):
        if key in expected_env and env.get(key) != expected_env[key]:
            raise HostLedgerError(f"backend host-ledger environment differs for {key}")
    expected_mount = profile_values.get("mount_root")
    mounts = [m for m in actual.get("Mounts", []) or [] if isinstance(m, Mapping) and m.get("Destination") == MOUNT_TARGET]
    if len(mounts) != 1 or not mounts[0].get("RW"):
        raise HostLedgerError("backend must have exactly one writable /host-ledger mount")
    if "daemon_volume" in profile_values:
        project = (config.get("Labels") or {}).get("com.docker.compose.project")
        frozen = profile_values["daemon_volume"]
        if not isinstance(frozen, Mapping):
            raise HostLedgerError("backend host-ledger volume descriptor is missing")
        fresh = profile_values.get("host_receipt")
        _validate_host_receipt(fresh, {"project_id": profile_values.get("project_id"),
            "mount_root": expected_mount, "backing_image": profile_values.get("backing_image")})
        descriptor = host_volume_descriptor(project, profile_values.get("project_id"), expected_mount,
            frozen.get("host_receipt"))
        if any(fresh.get(key) != descriptor[key] for key in ("loop_device", "filesystem_uuid", "backing_image")):
            raise HostLedgerError("backend host-ledger device identity differs from fresh maintenance receipt")
        if profile_values["daemon_volume"] != descriptor:
            raise HostLedgerError("backend host-ledger volume descriptor differs from canonical identity")
        mounted = mounts[0]
        if (mounted.get("Type") != "volume" or mounted.get("Name") != descriptor["name"]
                or mounted.get("Driver") != "local"):
            raise HostLedgerError("backend host-ledger must use the exact managed local-driver volume")
        output, _, combined = _invoke(docker_callable, "volume", "inspect", descriptor["name"], timeout=30)
        volume = _validate_host_volume(json.loads(output or combined), descriptor)
        if mounted.get("Source") != volume["Mountpoint"]:
            raise HostLedgerError("backend host-ledger source differs from the inspected volume mountpoint")
    elif mounts[0].get("Type") != "bind":
        raise HostLedgerError("backend must use a managed /host-ledger bind or volume descriptor")
    elif expected_mount is not None and not _same_daemon_path(mounts[0].get("Source"), expected_mount):
        raise HostLedgerError("backend /host-ledger source differs from the managed mount root")
    host_config = actual.get("HostConfig") or {}
    if host_config.get("Privileged") or config.get("User") != "65532:65532":
        raise HostLedgerError("backend host-ledger service isolation mismatch")
    _invoke(docker_callable, *backend_verify_command(container_id), timeout=60)

    maintenance = profile_values.get("maintenance_compose")
    image_id = profile_values.get("image_id")
    run_root = Path(profile_values.get("run_root") or Path(maintenance).parent if maintenance else ".")
    host_receipt = profile_values.get("host_receipt")
    if maintenance and image_id:
        # The maintenance file is already frozen and has no backend service.
        run_id = profile_values.get("run_id") or hashlib.sha256(str(run_root).encode()).hexdigest()[:32]
        verify_receipt: dict[str, Any] = {
            "run_id": run_id,
            "project_id": profile_values.get("project_id"),
            "mount_root": profile_values.get("mount_root"),
            "backing_image": profile_values.get("backing_image", ""),
        }
        host_receipt = _run_maintenance(run_root, Path(maintenance), image_id,
                                        f"fullmag-host-ledger-{run_root.name}", "verify",
                                        docker_callable, verify_receipt, 180)
    elif not isinstance(host_receipt, Mapping):
        raise HostLedgerError("live host-ledger verification evidence is missing")
    expected_receipt_values = {
        "project_id": profile_values.get("project_id"),
        "mount_root": profile_values.get("mount_root"),
        "backing_image": profile_values.get("backing_image"),
    }
    if any(not isinstance(value, str) or not value for value in expected_receipt_values.values()):
        raise HostLedgerError("live host-ledger verification lacks stable receipt identity")
    _validate_host_receipt(host_receipt, expected_receipt_values)
    return {
        "schema": "fullmag.docker-host-ledger-attestation.v1",
        "profile": PROFILE,
        "backend_container_id": container_id,
        "mount_source": mounts[0].get("Source"),
        "mount_target": MOUNT_TARGET,
        "ledger_root": LEDGER_ROOT,
        "filesystem": "ext4",
        "filesystem_uuid": host_receipt.get("filesystem_uuid"),
        "loop_device": host_receipt.get("loop_device"),
        "backing_image": host_receipt.get("backing_image"),
        "backend_verification": "PASS",
        "host_verification": "PASS",
        "host_receipt": host_receipt,
    }
