from __future__ import annotations

import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

import fullmag_storage as storage

PROFILE = "linux-native-v1"
CERTIFICATE_TARGET = "/run/fullmag/host-admission/linux-native-host.json"
_MAX_ID = 2**31 - 1


def _require_linux() -> None:
    if not sys.platform.startswith("linux"):
        raise ValueError("Native Docker storage requires Linux or WSL")


def runtime_identity(environment=None) -> tuple[int, int]:
    """Resolve the non-root caller identity and reject ambient user switching."""

    _require_linux()
    if not hasattr(os, "getuid") or not hasattr(os, "getgid"):
        raise ValueError("Native Linux runtime identity is unavailable")
    uid, gid = os.getuid(), os.getgid()
    if uid == 0 or gid == 0:
        raise ValueError("Linux Docker runtime requires a non-root caller UID and GID")
    if uid > _MAX_ID or gid > _MAX_ID:
        raise ValueError("Linux Docker runtime caller UID and GID exceed the supported range")
    values = os.environ if environment is None else environment
    for name, observed in (("FULLMAG_RUNTIME_UID", uid), ("FULLMAG_RUNTIME_GID", gid)):
        raw = values.get(name)
        if raw is None:
            continue
        if not isinstance(raw, str) or re.fullmatch(r"[1-9][0-9]*", raw) is None:
            raise ValueError(f"{name} must be a canonical nonzero decimal id")
        parsed = int(raw, 10)
        if parsed > _MAX_ID or parsed != observed:
            raise ValueError(f"{name} must equal the current non-root caller identity")
    return uid, gid


def local_volume(path):
    _require_linux()
    path = storage.absolute(path, "native Linux path")
    try:
        metadata = path.stat()
    except OSError as error:
        raise ValueError(f"Native Linux path must already exist: {path}") from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError(f"Native Linux storage path must be a directory: {path}")
    filesystem = storage.filesystem_type(path)
    if filesystem not in {"ext4", "xfs", "btrfs"}:
        raise ValueError(
            f"Native Docker storage requires ext4, xfs or btrfs; observed {filesystem}: {path}"
        )
    return {"filesystem": filesystem, "device": metadata.st_dev}


def _owned_parent(path: Path) -> Path:
    parent = storage.absolute(path.parent, "evidence parent")
    try:
        metadata = parent.stat()
    except OSError as error:
        raise ValueError("Evidence parent is unavailable") from error
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid():
        raise ValueError("Evidence parent must be a directory owned by the current user")
    return parent


def read_owned_regular(path, maximum=1024 * 1024):
    _require_linux()
    if not isinstance(maximum, int) or maximum < 0:
        raise ValueError("Owned evidence read limit is invalid")
    path = storage.absolute(path, "owned file")
    with os.fdopen(
        os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
    ) as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or info.st_uid != os.geteuid()
            or info.st_size > maximum
        ):
            raise ValueError("Owned evidence is not a private bounded regular file")
        data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise ValueError("Owned evidence exceeded the read limit")
        return data


def publish_evidence(path, value):
    """Atomically publish owner-only JSON evidence under the caller's identity."""

    _require_linux()
    runtime_identity()
    path = Path(path)
    parent = _owned_parent(path)
    path = parent / path.name
    try:
        previous = path.lstat()
    except FileNotFoundError:
        previous = None
    if previous is not None and (
        not stat.S_ISREG(previous.st_mode)
        or previous.st_nlink != 1
        or previous.st_uid != os.geteuid()
    ):
        raise ValueError("Existing evidence is not one regular file owned by the current user")
    temporary = parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        os.fchmod(descriptor, 0o600)
        data = (json.dumps(value, sort_keys=True, ensure_ascii=True, indent=2) + "\n").encode("utf-8")
        offset = 0
        while offset < len(data):
            written = os.write(descriptor, data[offset:])
            if written <= 0:
                raise OSError("short write while publishing Linux host evidence")
            offset += written
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise
    else:
        os.close(descriptor)
    os.replace(temporary, path)
    directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
