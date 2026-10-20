"""Validate the explicit Linux bind mount and publish process-local admission evidence."""
from __future__ import annotations

import fcntl
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
import tempfile
import uuid

PROFILE = "linux-native-v1"
CERTIFICATE = Path("/run/fullmag/linux-native-host.json")
CHECKS = ("file_sync", "directory_sync", "atomic_replace", "process_lock",
          "no_follow_symlink", "sqlite_transactions", "restart_readback")


def _open_nofollow(path, flags):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise RuntimeError("Linux evidence requires an absolute path without traversal")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        if path == Path("/"):
            return os.dup(directory)
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(path.name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except OSError as error:
        raise RuntimeError("Linux evidence has an inaccessible or symlink component") from error
    finally:
        os.close(directory)


def read_regular(path, maximum=1024 * 1024):
    descriptor = _open_nofollow(path, os.O_RDONLY)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
            raise RuntimeError("Linux evidence must be one bounded regular file")
        data = stream.read(maximum + 1)
        if len(data) > maximum:
            raise RuntimeError("Linux evidence exceeded its read limit")
        return data


def validate_host(state=Path("/state"), certificate=CERTIFICATE, *, require_restart=True):
    state = Path(state)
    raw = read_regular(certificate)
    host = json.loads(raw)
    owner = json.loads(read_regular(state / ".fullmag-linux-native-owner.json"))
    token = host.get("owner_token", "")
    image = os.environ.get("FULLMAG_RUNTIME_IMAGE_ID", "")
    if (host != owner or host.get("schema") != "fullmag.linux-native-host.v1"
            or host.get("storage_profile") != PROFILE
            or host.get("role") != "session"
            or host.get("owner_scope") != "docker-linux"
            or not isinstance(token, str) or re.fullmatch(r"[0-9a-f]{32}", token) is None
            or not isinstance(host.get("engine_id"), str) or not host["engine_id"]
            or re.fullmatch(r"sha256:[0-9a-f]{64}", image) is None
            or host.get("image_id") != image):
        raise RuntimeError("Linux native host certificate scope/owner/image differs")
    engine_digest = hashlib.sha256(host["engine_id"].encode()).hexdigest()
    if os.environ.get("FULLMAG_DOCKER_HOST_ID") != engine_digest:
        raise RuntimeError("Linux native Docker engine differs from runtime admission")
    payload = (token + ":" + image).encode()
    if (read_regular(state / ".linux-native-sentinel") != payload
            or hashlib.sha256(payload).hexdigest() != host.get("restart_expected_sha256")):
        raise RuntimeError("Linux native host sentinel differs")
    if require_restart and host.get("restart_verified") is not True:
        raise RuntimeError("Linux native host restart readback is not verified")
    return host, raw, payload


def _publish(path, value):
    path = Path(path)
    directory = _open_nofollow(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    temporary = path.name + "." + uuid.uuid4().hex
    try:
        try:
            current = os.stat(path.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                raise RuntimeError("Linux evidence publication refuses links and nonregular files")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o644, dir_fd=directory)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            # Results must be readable by the host even under a restrictive umask.
            os.fchmod(stream.fileno(), 0o644)
            os.fsync(stream.fileno())
        os.replace(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def run(require_restart=True, state=Path("/state"), certificate=CERTIFICATE):
    state = Path(state)
    kind = subprocess.check_output(["stat", "-f", "-c", "%t", str(state)], text=True).strip().lower().lstrip("0")
    if kind not in {"ef53", "58465342", "9123683e"}:
        raise RuntimeError("Linux native sessions require ext4, xfs or btrfs")
    host, raw, payload = validate_host(state, certificate, require_restart=require_restart)
    directory = Path(tempfile.mkdtemp(prefix=".linux-native-probe-", dir=state))
    checks = {}
    try:
        target = directory / "data"
        _publish(target, payload)
        checks["file_sync"] = checks["directory_sync"] = checks["atomic_replace"] = read_regular(target) == payload
        lock = os.open(directory / "lock", os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code = "import fcntl,os,sys; f=os.open(sys.argv[1],os.O_RDWR); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)"
            result = subprocess.run([sys.executable, "-c", code, str(directory / "lock")], capture_output=True, timeout=10)
            checks["process_lock"] = result.returncode != 0 and b"BlockingIOError" in result.stderr
        finally:
            os.close(lock)
        link = directory / "link"
        link.symlink_to(target)
        try:
            read_regular(link)
        except (OSError, RuntimeError):
            checks["no_follow_symlink"] = True
        else:
            checks["no_follow_symlink"] = False
        database = directory / "probe.sqlite"
        with sqlite3.connect(database) as connection:
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("CREATE TABLE probe (value TEXT)")
            connection.execute("INSERT INTO probe VALUES (?)", (payload.decode(),))
        with sqlite3.connect(database) as connection:
            checks["sqlite_transactions"] = connection.execute("SELECT value FROM probe").fetchone() == (payload.decode(),)
        restart = state / ".linux-native-restart"
        if require_restart:
            checks["restart_readback"] = read_regular(restart) == payload
        else:
            if restart.exists() and read_regular(restart) != payload:
                raise RuntimeError("Linux native restart sentinel belongs to another owner")
            checks["restart_readback"] = True
            _publish(restart, payload)
        if set(checks) != set(CHECKS) or not all(checks.values()):
            raise RuntimeError("Linux native storage probe failed")
        metadata = state.stat()
        evidence = {"schema": "fullmag.linux-native-probe.v1", "storage_profile": PROFILE,
                    "owner_token": host["owner_token"], "image_id": host["image_id"], "host_attestation_sha256": hashlib.sha256(raw).hexdigest(),
                    "root_device": metadata.st_dev, "root_inode": metadata.st_ino,
                    "mount_namespace_inode": Path("/proc/self/ns/mnt").stat().st_ino,
                    "checks": checks}
        _publish(state / ".linux-native-probe.json", json.dumps(evidence, sort_keys=True).encode())
        return evidence
    finally:
        shutil.rmtree(directory)
