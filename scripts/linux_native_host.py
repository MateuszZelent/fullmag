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


DEVICE_READMISSION_SCHEMA = "fullmag.linux-native-device-readmission-preparation.v1"
READMISSION_FILES = (CERTIFICATE_NAME, OWNER_NAME, ".linux-native-probe.json",
                    ".linux-native-sentinel", ".linux-native-restart")


def _readmission_digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _readmission_json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("Readmission evidence contains a duplicate JSON key")
            value[key] = item
        return value
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise ValueError("Readmission evidence must be a JSON object")
    return value


def _readmission_encoded(value):
    # Exactly the representation used by publish_evidence/write_bound_evidence.
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()


def readmission_source_binding_sha256(certificate):
    """Pin existing image/source/binary provenance; never rotate it here."""
    fields = ("image_id", "source_commit", "binary_hashes", "artifact_receipt_sha256")
    if not isinstance(certificate, dict) or any(key not in certificate for key in fields):
        raise ValueError("Readmission requires the existing source/binary binding")
    value = {key: certificate[key] for key in fields}
    if "development_build" in certificate:
        value["development_build"] = certificate["development_build"]
    return _readmission_digest(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                         allow_nan=False).encode())


def _readmission_validate(state, pins, original):
    required = {"state_root", "engine_id", "owner_token", "image_id", "source_binding_sha256",
                "retained_device", "observed_device", "root_inode", "files"}
    if not isinstance(pins, dict) or set(pins) != required:
        raise ValueError("Readmission pins differ from the closed contract")
    if pins["state_root"] != str(state):
        raise ValueError("Readmission state root differs")
    if (any(type(pins[key]) is not int or pins[key] <= 0
            for key in ("retained_device", "observed_device", "root_inode"))
            or pins["retained_device"] == pins["observed_device"]):
        raise ValueError("Readmission requires exact distinct old/new device and inode pins")
    if (not isinstance(pins["engine_id"], str) or not pins["engine_id"]
            or len(pins["engine_id"]) > 256
            or not isinstance(pins["owner_token"], str)
            or re.fullmatch(r"[0-9a-f]{32}", pins["owner_token"]) is None
            or set(pins["owner_token"]) == {"0"}
            or not isinstance(pins["image_id"], str)
            or re.fullmatch(r"sha256:[0-9a-f]{64}", pins["image_id"]) is None):
        raise ValueError("Readmission engine/owner/image pins differ")
    hashes = pins["files"]
    if (not isinstance(hashes, dict) or set(hashes) != set(READMISSION_FILES)
            or not isinstance(original, dict) or set(original) != set(READMISSION_FILES)
            or any(not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None
                   for value in (*hashes.values(), pins["source_binding_sha256"]))):
        raise ValueError("Readmission requires all five exact raw-file digests")
    if any(not isinstance(original[name], bytes) or not original[name]
           or len(original[name]) > 1024 * 1024
           or _readmission_digest(original[name]) != hashes[name] for name in READMISSION_FILES):
        raise ValueError("Readmission original raw evidence CAS differs")
    certificate = _readmission_json(original[CERTIFICATE_NAME])
    if (_readmission_json(original[OWNER_NAME]) != certificate
            or certificate.get("schema") != HOST_SCHEMA
            or certificate.get("storage_profile") != PROFILE
            or certificate.get("role") != "session" or certificate.get("owner_scope") != "docker-linux"
            or certificate.get("restart_verified") is not True
            or certificate.get("host_device") != pins["retained_device"]
            or certificate.get("host_inode") != pins["root_inode"]
            or any(certificate.get(key) != pins[key] for key in ("engine_id", "owner_token", "image_id"))
            or readmission_source_binding_sha256(certificate) != pins["source_binding_sha256"]):
        raise ValueError("Readmission retained certificate ownership/source differs")
    native = local_volume(state)
    metadata = state.stat()
    if (metadata.st_dev != pins["observed_device"] or metadata.st_ino != pins["root_inode"]
            or native.get("host_device") != pins["observed_device"]
            or native.get("host_root") != str(state) or native.get("host_platform") != "linux"
            or native.get("host_filesystem") not in {"ext4", "xfs", "btrfs"}
            or native.get("host_root_no_reparse") is not True
            or any(certificate.get(key) != value for key, value in native.items() if key != "host_device")):
        raise ValueError("Readmission observed host identity differs beyond the device pin")
    payload = (pins["owner_token"] + ":" + pins["image_id"]).encode("ascii")
    if (original[".linux-native-sentinel"] != payload or original[".linux-native-restart"] != payload
            or certificate.get("restart_expected_sha256") != _readmission_digest(payload)):
        raise ValueError("Readmission retained restart/sentinel binding differs")
    probe = _readmission_json(original[".linux-native-probe.json"])
    if (probe.get("schema") != "fullmag.linux-native-probe.v1"
            or probe.get("storage_profile") != PROFILE
            or probe.get("owner_token") != pins["owner_token"] or probe.get("image_id") != pins["image_id"]
            or probe.get("host_attestation_sha256") != hashes[CERTIFICATE_NAME]
            or probe.get("root_inode") != pins["root_inode"]
            or not isinstance(probe.get("checks"), dict) or set(probe["checks"]) != CHECKS
            or any(value is not True for value in probe["checks"].values())):
        raise ValueError("Readmission retained namespace evidence differs")
    candidate = dict(certificate, host_device=pins["observed_device"], restart_verified=False)
    return candidate, _readmission_encoded(candidate)


def _readmission_certificate_inode(state):
    descriptor = _open_nofollow(state / CERTIFICATE_NAME, os.O_RDONLY)
    try:
        value = os.fstat(descriptor)
        if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > 1024 * 1024:
            raise ValueError("Readmission certificate must remain one bounded regular file")
        return [value.st_dev, value.st_ino, value.st_uid, value.st_mode, value.st_nlink]
    finally:
        os.close(descriptor)


def prepare_device_readmission(state, pins):
    """Read-only preparation. The managed caller must archive it before apply.

    This is not a namespace grant. The caller owns the operation, native
    startup/owner, ledger and store guards and independently proves no consumers.
    """
    state = storage.absolute(state, "Linux device readmission state")
    original = {name: read_owned_regular(state / name) for name in READMISSION_FILES}
    candidate, raw = _readmission_validate(state, pins, original)
    return {"schema": DEVICE_READMISSION_SCHEMA, "pins": json.loads(json.dumps(pins)),
            "original": original, "candidate": candidate, "candidate_raw": raw,
            "candidate_sha256": _readmission_digest(raw),
            "certificate_inode": _readmission_certificate_inode(state)}


def _readmission_phase(state, preparation, *, archived_marker_sha256=None):
    candidate, raw = _readmission_validate(state, preparation["pins"], preparation["original"])
    if (preparation["candidate"] != candidate or preparation["candidate_raw"] != raw
            or preparation["candidate_sha256"] != _readmission_digest(raw)
            or preparation["certificate_inode"] != _readmission_certificate_inode(state)):
        raise ValueError("Readmission candidate or certificate bind inode changed")
    current = {name: read_owned_regular(state / name) for name in READMISSION_FILES}
    for name in READMISSION_FILES[2:]:
        if current[name] != preparation["original"][name]:
            raise ValueError("Readmission protected evidence changed: " + name)
    archive_order_raw = (json.dumps(candidate, indent=2, ensure_ascii=False, sort_keys=True,
                                    allow_nan=False) + "\n").encode()
    if archived_marker_sha256 is not None:
        if (not isinstance(archived_marker_sha256, str)
                or re.fullmatch(r"[0-9a-f]{64}", archived_marker_sha256) is None
                or _readmission_digest(archive_order_raw) != archived_marker_sha256):
            raise ValueError("Readmission archived marker pin differs from its deterministic encoding")
    pair = (current[CERTIFICATE_NAME], current[OWNER_NAME])
    original = preparation["original"]
    if pair == (original[CERTIFICATE_NAME], original[OWNER_NAME]):
        return "original"
    if pair == (original[CERTIFICATE_NAME], raw):
        return "marker-published"
    if pair == (raw, raw):
        return "prepared"
    if archived_marker_sha256 is not None and pair == (original[CERTIFICATE_NAME], archive_order_raw):
        return "marker-published-archive-order"
    raise ValueError("Readmission certificate/marker bytes are foreign, torn or reversed")


def apply_device_readmission(state, preparation, *, archived_marker_sha256=None):
    """Prepare two existing admission files, with no probe or runtime action.

    Required caller-held guards and immutable control-volume archive are the
    managed wrapper's responsibility. Unknown bytes are never overwritten.
    """
    state = storage.absolute(state, "Linux device readmission state")
    required = {"schema", "pins", "original", "candidate", "candidate_raw", "candidate_sha256", "certificate_inode"}
    if (not isinstance(preparation, dict) or set(preparation) != required
            or preparation["schema"] != DEVICE_READMISSION_SCHEMA):
        raise ValueError("Readmission preparation schema differs")
    phase = _readmission_phase(state, preparation, archived_marker_sha256=archived_marker_sha256)
    if phase in {"original", "marker-published-archive-order"}:
        publish_bytes(state / OWNER_NAME, preparation["candidate_raw"])
        if _readmission_phase(state, preparation) != "marker-published":
            raise ValueError("Readmission marker publication did not reach its exact phase")
    if phase != "prepared":
        write_bound_evidence(state / CERTIFICATE_NAME, _readmission_json(preparation["candidate_raw"]))
    if _readmission_phase(state, preparation) != "prepared":
        raise ValueError("Readmission certificate publication did not reach its exact phase")
    return {"state": "prepared-not-admitted", "namespace_admitted": False,
            "certificate_sha256": preparation["candidate_sha256"], "previous_phase": phase}
