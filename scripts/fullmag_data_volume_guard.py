"""Read-only startup verification for explicitly registered data volumes."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess

try:
    from . import fullmag_data_volume as _model
except ImportError:  # Support launchers that put scripts/ directly on sys.path.
    import fullmag_data_volume as _model


_MAX_RECORD_BYTES = 256 * 1024
_MAX_INDEX_BYTES = 16 * 1024 * 1024
_MAX_FINDMNT_BYTES = 64 * 1024
_HEX32 = re.compile(r"[0-9a-f]{32}\Z", re.ASCII)
_HEX64 = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_IDENTIFIER = re.compile(r"[a-z0-9._-]{1,128}\Z", re.ASCII)
_INDEX_REFERENCE_KEYS = frozenset({"path", "sha256", "volume_id"})


def _fail(message: str) -> None:
    raise ValueError(message)


def _absolute_path(value, label: str) -> Path:
    if isinstance(value, Path):
        raw = str(value)
    elif type(value) is str:
        raw = value
    else:
        _fail(f"{label} must be an absolute path")
    if not raw or any(ord(character) < 32 or ord(character) == 127 for character in raw):
        _fail(f"{label} is empty or contains control characters")
    path = Path(raw)
    if (
        not path.is_absolute()
        or ".." in path.parts
        or str(path) != raw
    ):
        _fail(f"{label} must be a canonical absolute path without traversal")
    return path


def _open_directory_nofollow(path: Path) -> int:
    path = _absolute_path(path, "directory path")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        _fail("read-only volume guard requires no-follow directory opens")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    descriptor = os.open(path.anchor, flags)
    try:
        for component in path.parts[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        info = os.fstat(descriptor)
        if not stat.S_ISDIR(info.st_mode):
            _fail(f"directory path is not a directory: {path}")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _observe_directory(path) -> dict[str, int]:
    """Read one directory's device/inode without following any path links."""

    path = _absolute_path(path, "observed directory")
    descriptor = _open_directory_nofollow(path)
    try:
        opened = os.fstat(descriptor)
    finally:
        os.close(descriptor)

    try:
        observed = path.stat(follow_symlinks=False)
    except OSError as error:
        raise ValueError(f"cannot stat observed directory: {path}") from error
    if (
        not stat.S_ISDIR(observed.st_mode)
        or (opened.st_dev, opened.st_ino) != (observed.st_dev, observed.st_ino)
    ):
        _fail(f"observed directory changed or traverses a link: {path}")
    return {"device": int(observed.st_dev), "inode": int(observed.st_ino)}


def _open_optional_regular(path: Path) -> int | None:
    """Open a file with no-follow traversal; return None only when absent."""

    path = _absolute_path(path, "record path")
    if len(path.parts) < 2:
        _fail("record path must name a file")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        _fail("read-only volume guard requires no-follow file opens")

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if hasattr(os, "O_CLOEXEC"):
        directory_flags |= os.O_CLOEXEC
        file_flags |= os.O_CLOEXEC

    descriptor = os.open(path.anchor, directory_flags)
    try:
        for component in path.parts[1:-1]:
            try:
                child = os.open(component, directory_flags, dir_fd=descriptor)
            except FileNotFoundError:
                return None
            os.close(descriptor)
            descriptor = child
        try:
            return os.open(path.name, file_flags, dir_fd=descriptor)
        except FileNotFoundError:
            return None
    finally:
        os.close(descriptor)


def _read_optional_regular(
    path: Path, label: str, maximum: int = _MAX_RECORD_BYTES
) -> bytes | None:
    descriptor = _open_optional_regular(path)
    if descriptor is None:
        return None
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_size > maximum
        ):
            _fail(f"{label} must be one bounded regular file")
        chunks = []
        remaining = maximum + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > maximum:
            _fail(f"{label} exceeds its size bound")
        return raw
    finally:
        os.close(descriptor)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("JSON record contains a duplicate object key")
        result[key] = value
    return result


def _finite_float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        _fail("JSON record contains a nonfinite number")
    return result


def _reject_constant(value: str):
    _fail(f"JSON record contains a nonfinite value: {value}")


def _parse_object(raw: bytes, label: str) -> dict:
    try:
        value = json.loads(
            raw.decode("utf-8", "strict"),
            object_pairs_hook=_unique_object,
            parse_float=_finite_float,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ValueError(f"{label} is not safe JSON") from error
    if type(value) is not dict:
        _fail(f"{label} must be a JSON object")
    return value


def _validate_index_reference(index: dict, registration_path: Path) -> dict | None:
    if "data_volume_registration" not in index:
        return None
    reference = index["data_volume_registration"]
    if type(reference) is not dict or any(type(key) is not str for key in reference):
        _fail("worktree data_volume_registration must be an object")
    if frozenset(reference) != _INDEX_REFERENCE_KEYS:
        _fail("worktree data_volume_registration has an open or incomplete shape")

    path_value = reference["path"]
    if type(path_value) is not str:
        _fail("worktree data-volume registration path must be a string")
    reference_path = _absolute_path(path_value, "worktree data-volume registration path")
    if reference_path != registration_path or path_value != str(registration_path):
        _fail("worktree data-volume registration path differs from its canonical path")

    digest = reference["sha256"]
    if type(digest) is not str or _HEX64.fullmatch(digest) is None:
        _fail("worktree data-volume registration SHA-256 is invalid")
    volume_id = reference["volume_id"]
    if (
        type(volume_id) is not str
        or _HEX32.fullmatch(volume_id) is None
        or volume_id == "0" * 32
    ):
        _fail("worktree data-volume registration volume_id is invalid")
    return reference


def _run_findmnt(path: Path) -> dict:
    command = [
        "findmnt",
        "--json",
        "--target",
        str(path),
        "--output",
        "TARGET,FSTYPE,UUID",
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(f"cannot observe mount for {path}") from error
    if (
        result.returncode != 0
        or len(result.stdout) > _MAX_FINDMNT_BYTES
        or len(result.stderr) > _MAX_FINDMNT_BYTES
    ):
        _fail(f"findmnt returned no bounded mount observation for {path}")

    payload = _parse_object(result.stdout, "findmnt output")
    filesystems = payload.get("filesystems")
    if type(filesystems) is not list or len(filesystems) != 1 or type(filesystems[0]) is not dict:
        _fail("findmnt must return exactly one filesystem observation")
    row = filesystems[0]

    def field(upper: str, lower: str) -> str:
        if upper in row and lower in row:
            _fail(f"findmnt returned ambiguous {upper} fields")
        value = row.get(upper, row.get(lower))
        if type(value) is not str or not value:
            _fail(f"findmnt omitted or invalidated {upper}")
        return value

    return {
        "target": field("TARGET", "target"),
        "filesystem": field("FSTYPE", "fstype"),
        "filesystem_uuid": field("UUID", "uuid"),
    }


def _observe_mount(path) -> dict:
    """Observe one exact mount target with findmnt and a no-follow stat."""

    path = _absolute_path(path, "mount observation path")
    identity = _observe_directory(path)
    mount = _run_findmnt(path)
    mount.update(identity)
    return mount


def _strict_child(path: Path, root: Path) -> bool:
    return path != root and root in path.parents


def _validate_roots(registration: dict, layout: dict, compose_project: str,
                    state_root, user_data_root) -> None:
    storage_root = _absolute_path(layout["storage_root"], "storage_root")
    runtime_root = _absolute_path(layout["runtime_root"], "runtime_root")
    user_data_base = storage_root / "user-data"
    datasets = {entry["role"]: entry for entry in registration["datasets"]}
    registered_user_data = _absolute_path(
        datasets["user_data"]["canonical_root"], "registered user_data root"
    )
    registered_state = _absolute_path(
        datasets["state"]["canonical_root"], "registered state root"
    )
    expected_user_data = (
        _absolute_path(user_data_root, "user_data_root")
        if user_data_root is not None
        else user_data_base / compose_project
    )
    if registered_user_data != expected_user_data:
        _fail("registered user_data root differs from the selected canonical root")
    if not _strict_child(registered_user_data, user_data_base):
        _fail("registered user_data root is outside storage_root/user-data")
    if not _strict_child(registered_state, runtime_root):
        _fail("registered state root is outside layout runtime_root")
    if state_root is not None and _absolute_path(state_root, "state_root") != registered_state:
        _fail("selected state_root differs from the registered state root")


def verify_registered_volume(
    layout: dict,
    compose_project: str,
    *,
    state_root: Path | None = None,
    user_data_root: Path | None = None,
) -> dict | None:
    """Verify an explicit volume opt-in, otherwise return ``None`` untouched.

    This function only reads the worktree/volume records and mount metadata.
    It never creates, mounts, deletes, admits, or falls back to another root.
    """

    if type(layout) is not dict:
        _fail("layout must be an object")
    worktree_id = layout.get("worktree_id")
    if type(worktree_id) is not str or _IDENTIFIER.fullmatch(worktree_id) is None:
        _fail("layout worktree_id is invalid")
    storage_root = _absolute_path(layout.get("storage_root"), "storage_root")
    index_path = storage_root / "index" / f"{worktree_id}.json"
    registration_path = (
        storage_root / "index" / "data-volumes" / f"{worktree_id}.json"
    )

    index_raw = _read_optional_regular(
        index_path, "worktree index", maximum=_MAX_INDEX_BYTES
    )
    registration_raw = _read_optional_regular(
        registration_path, "data-volume registration"
    )
    index = _parse_object(index_raw, "worktree index") if index_raw is not None else None
    reference = (
        _validate_index_reference(index, registration_path)
        if index is not None
        else None
    )
    if index is None and registration_raw is None:
        return None
    if (registration_raw is None) != (reference is None):
        _fail("data-volume registration and worktree index reference must both exist")
    if registration_raw is None or reference is None:
        return None

    if type(compose_project) is not str or not compose_project or "/" in compose_project or "\\" in compose_project:
        _fail("compose_project must be a nonempty single path component")
    env = layout.get("env")
    if type(env) is not dict or type(env.get("FULLMAG_PROJECT_ID")) is not str:
        _fail("layout env has no FULLMAG_PROJECT_ID")
    if "runtime_root" not in layout:
        _fail("layout has no runtime_root")
    _absolute_path(layout["runtime_root"], "runtime_root")

    registration = _parse_object(registration_raw, "data-volume registration")
    if hashlib.sha256(registration_raw).hexdigest() != reference["sha256"]:
        _fail("data-volume registration SHA-256 differs from the worktree index")
    registration = _model.validate_registration(registration)
    if reference["volume_id"] != registration["volume_id"]:
        _fail("data-volume registration volume_id differs from the worktree index")
    if (
        registration["project_id"] != env["FULLMAG_PROJECT_ID"]
        or registration["worktree_id"] != worktree_id
        or registration["compose_project"] != compose_project
    ):
        _fail("data-volume registration identity differs from the active layout")

    _validate_roots(registration, layout, compose_project, state_root, user_data_root)
    mount_root = _absolute_path(registration["mount_root"], "registered mount_root")

    volume_observation = _observe_mount(mount_root)
    if volume_observation.get("target") != str(mount_root):
        _fail("registered volume mount is not mounted at its exact mount_root")
    observations = {
        "volume": {
            "target": volume_observation["target"],
            "filesystem": volume_observation["filesystem"],
            "filesystem_uuid": volume_observation["filesystem_uuid"],
            "device": volume_observation["device"],
            "inode": volume_observation["inode"],
        }
    }

    for dataset in registration["datasets"]:
        role = dataset["role"]
        canonical_root = _absolute_path(dataset["canonical_root"], f"{role} canonical root")
        canonical_mount = _observe_mount(canonical_root)
        if canonical_mount.get("target") != str(canonical_root):
            _fail(f"{role} canonical root is not an exact bind-mount target")

        volume_root = mount_root / dataset["relative_root"]
        volume_identity = _observe_directory(volume_root)
        observations[role] = {
            "canonical_root": str(canonical_root),
            "volume_root": str(volume_root),
            "filesystem": canonical_mount["filesystem"],
            "filesystem_uuid": canonical_mount["filesystem_uuid"],
            "canonical_device": canonical_mount["device"],
            "canonical_inode": canonical_mount["inode"],
            "volume_device": volume_identity["device"],
            "volume_inode": volume_identity["inode"],
        }

    return _model.validate_mount_evidence(registration, observations)
