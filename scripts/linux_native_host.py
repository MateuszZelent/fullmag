"""Host evidence and UID admission for native Linux/WSL Docker session binds."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import uuid

import fullmag_storage as storage
from docker_dev_host import local_volume

HOST_SCHEMA = "fullmag.linux-native-host.v1"
PROFILE = "linux-native-v1"
OWNER_NAME = ".fullmag-linux-native-owner.json"
CERTIFICATE_NAME = "linux-native-host.json"
HOST_CERT_PATH = "/run/fullmag/" + CERTIFICATE_NAME
CHECKS = {"file_sync", "directory_sync", "atomic_replace", "process_lock",
          "sqlite_transactions", "restart_readback", "no_follow_symlink"}
RUNTIME_DIRECTORIES = ("runs", "runs/docker-all", "runs/docker-all/session-store",
                       "runs/docker-all/session-store/runtime-services")


def _open_nofollow(path, flags):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Linux evidence requires an absolute path without traversal")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        if path == Path("/"):
            return os.dup(directory)
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        return os.open(path.name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)


def read_owned_regular(path, maximum=1024 * 1024):
    path = storage.absolute(path, "Linux evidence")
    descriptor = _open_nofollow(path, os.O_RDONLY)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
            raise ValueError("Linux evidence must be one bounded regular file")
        result = stream.read(maximum + 1)
        if len(result) > maximum:
            raise ValueError("Linux evidence exceeds its size bound")
        return result


def publish_bytes(path, payload):
    path = storage.absolute(path, "Linux evidence publication")
    parent = _open_nofollow(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    temporary = "." + path.name + "." + uuid.uuid4().hex
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o644, dir_fd=parent)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


def publish_evidence(path, value):
    publish_bytes(path, (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode())


def write_bound_evidence(path, value, maximum=1024 * 1024):
    """Flush a certificate in place so Docker's readonly file bind sees it."""
    payload = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()
    if len(payload) > maximum:
        raise ValueError("Linux bound evidence exceeds its size bound")
    descriptor = _open_nofollow(path, os.O_RDWR)
    with os.fdopen(descriptor, "r+b", buffering=0) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
            raise ValueError("Linux bound evidence must be one bounded regular file")
        previous = stream.read(maximum + 1)
        try:
            stream.seek(0)
            stream.truncate()
            offset = 0
            while offset < len(payload):
                written = stream.write(payload[offset:])
                if not written:
                    raise OSError("Linux bound evidence write made no progress")
                offset += written
            os.fsync(stream.fileno())
            stream.seek(0)
            if stream.read(maximum + 1) != payload:
                raise ValueError("Linux bound evidence readback differs")
        except BaseException:
            stream.seek(0)
            stream.truncate()
            stream.write(previous)
            os.fsync(stream.fileno())
            raise


def _admit_runtime_uid_descriptor(descriptor):
    metadata = os.fstat(descriptor)
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
        raise ValueError("Linux runtime directory belongs to another operator")
    undefined = 0xffffffff
    users = sorted({os.getuid(), 65532})
    entries = [(1, 7, undefined), *[(2, 7, uid) for uid in users],
               (4, 0, undefined), (16, 7, undefined), (32, 0, undefined)]
    acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries)
    os.setxattr(descriptor, "system.posix_acl_access", acl)
    os.setxattr(descriptor, "system.posix_acl_default", acl)
    os.fsync(descriptor)


def admit_runtime_uid(path):
    """Grant only the fixed runtime UID and operator access to a session bind.

    Linux UAPI POSIX ACL v2 keeps UID 65532 usable without world-writable
    directories or changing ownership. Defaults preserve operator access to
    guest-created results. This is scoped to runtime data, never the checkout.
    """
    path = storage.absolute(path, "Linux runtime data")
    descriptor = _open_nofollow(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        _admit_runtime_uid_descriptor(descriptor)
    finally:
        os.close(descriptor)


def prepare_runtime_directories(state):
    """Create only fresh bind parents before Docker creates nested mount targets.

    Docker's WSL mount setup can create these as UID 65534 with a read-only
    ACL mask. Preparing the exact parents as the operator keeps UID 65532 able
    to initialize its store. Existing trees require recovery, never ACL repair.
    """
    state = storage.absolute(state, "new Linux runtime state")
    descriptors = {"": _open_nofollow(state, os.O_RDONLY | os.O_DIRECTORY)}
    try:
        root = descriptors[""]
        if os.fstat(root).st_uid != os.getuid():
            raise ValueError("Linux runtime directory belongs to another operator")
        for relative in RUNTIME_DIRECTORIES:
            try:
                os.stat(relative, dir_fd=root, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise ValueError("New Linux runtime state already contains " + relative)
        _admit_runtime_uid_descriptor(root)
        for relative in RUNTIME_DIRECTORIES:
            path = Path(relative)
            parent = descriptors["" if path.parent == Path(".") else str(path.parent)]
            os.mkdir(path.name, mode=0o770, dir_fd=parent)
            descriptor = os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                 dir_fd=parent)
            descriptors[relative] = descriptor
            _admit_runtime_uid_descriptor(descriptor)
            os.fsync(parent)
        return RUNTIME_DIRECTORIES
    finally:
        for descriptor in reversed(tuple(descriptors.values())):
            os.close(descriptor)


def attest(state, assembly, engine_id, binary_hashes, development_build=None):
    native = local_volume(state)
    if not engine_id or not re.fullmatch(r"sha256:[0-9a-f]{64}", assembly["image_id"]):
        raise ValueError("Linux storage admission requires engine and immutable image identity")
    marker = Path(state) / OWNER_NAME
    if marker.exists():
        raise ValueError("Linux session storage already has an owner")
    owner = uuid.uuid4().hex
    payload = (owner + ":" + assembly["image_id"]).encode("ascii")
    certificate = {"schema": HOST_SCHEMA, "storage_profile": PROFILE, "role": "session",
        "owner_scope": "docker-linux", **native, "host_inode": Path(state).stat().st_ino,
        "owner_token": owner, "engine_id": engine_id, "image_id": assembly["image_id"],
        "source_commit": assembly["commit"], "binary_hashes": binary_hashes,
        "artifact_receipt_sha256": assembly["build_receipt_sha256"],
        "restart_expected_sha256": hashlib.sha256(payload).hexdigest(), "restart_verified": False}
    if development_build is not None:
        certificate["development_build"] = development_build
    publish_bytes(Path(state) / ".linux-native-sentinel", payload)
    publish_evidence(marker, certificate)
    return certificate


def reuse_certificate(reuse, assembly, engine_id, *, development_build=None):
    state = Path(reuse["state"])
    certificate = json.loads(read_owned_regular(reuse["host_certificate"]))
    marker = json.loads(read_owned_regular(state / OWNER_NAME))
    if (certificate != marker or certificate.get("schema") != HOST_SCHEMA
            or certificate.get("storage_profile") != PROFILE or certificate.get("engine_id") != engine_id
            or certificate.get("image_id") != reuse["receipt"].get("image_id")
            or certificate.get("host_inode") != state.stat().st_ino
            or not re.fullmatch(r"[0-9a-f]{32}", certificate.get("owner_token", ""))):
        raise ValueError("Retained Linux storage ownership differs")
    if any(certificate.get(key) != value for key, value in local_volume(state).items()):
        raise ValueError("Retained Linux volume identity differs")
    certificate.update(image_id=assembly["image_id"], source_commit=assembly["commit"],
        binary_hashes=assembly["binary_hashes"], artifact_receipt_sha256=assembly["build_receipt_sha256"],
        restart_verified=False)
    payload = (certificate["owner_token"] + ":" + assembly["image_id"]).encode("ascii")
    certificate["restart_expected_sha256"] = hashlib.sha256(payload).hexdigest()
    if development_build is not None:
        certificate["development_build"] = development_build
    publish_bytes(state / ".linux-native-sentinel", payload)
    # A replacement image needs a fresh readback of its new sentinel.
    restart = state / ".linux-native-restart"
    if restart.exists():
        publish_bytes(restart, payload)
    publish_evidence(state / OWNER_NAME, certificate)
    publish_evidence(reuse["host_certificate"], certificate)
    return certificate


def complete_preflight(docker_client, container_id, state, certificate_path, certificate, *, log_writer):
    logs = [docker_client("exec", container_id, "/usr/local/bin/python3", "/opt/fullmag/entrypoint.py",
                          "--storage-probe", timeout=120, combined=True) for _ in range(2)]
    log_writer("\n".join(logs))
    state = Path(state)
    if certificate.get("host_inode") != state.stat().st_ino:
        raise ValueError("Linux session directory inode changed")
    probe = json.loads(read_owned_regular(state / ".linux-native-probe.json"))
    if (probe.get("schema") != "fullmag.linux-native-probe.v1"
            or probe.get("image_id") != certificate["image_id"]
            or probe.get("owner_token") != certificate["owner_token"]
            or not CHECKS.issubset(probe.get("checks", {}))
            or any(value is not True for value in probe["checks"].values())):
        raise ValueError("Linux storage operational checks failed")
    if hashlib.sha256(read_owned_regular(state / ".linux-native-restart")).hexdigest() != certificate["restart_expected_sha256"]:
        raise ValueError("Linux guest restart readback differs")
    if any(certificate.get(key) != value for key, value in local_volume(state).items()):
        raise ValueError("Linux host volume changed during guest admission")
    certificate["restart_verified"] = True
    # Keep the certificate bind inode; publish owner first, then allow the gate.
    publish_evidence(state / OWNER_NAME, certificate)
    write_bound_evidence(certificate_path, certificate)
    docker_client("exec", container_id, "/usr/local/bin/python3", "/opt/fullmag/entrypoint.py",
                  "--storage-probe", timeout=120, combined=True)
