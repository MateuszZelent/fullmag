"""Prove a WSL Docker Desktop alias is backed by a separate local filesystem.

This helper reads only the alias root's stat metadata and bounded kernel
mountinfo snapshots. It never traverses the alias tree or opens files below
the alias root.
"""
from __future__ import annotations

import hashlib
import os
import posixpath
from pathlib import Path
import re
import stat
import unicodedata
from collections.abc import Iterable, Mapping

import docker_bind_overlap_probe as bind_probe
from docker_build_control import BuildControlError, canonical
from docker_foreign_bind_identity import WSL_ALIAS


PROOF_SCHEMA = "fullmag.group-local-foreign-filesystem-alias.v1"
MOUNTINFO_PATH = "/proc/self/mountinfo"
LOCAL_ALIAS_ROOT = Path("/mnt/wsl/docker-desktop-bind-mounts/Ubuntu2")
MAX_MOUNTINFO_BYTES = bind_probe.MAX_MOUNTINFO_BYTES
MAX_ALIAS_MOUNTS = 256
FILESYSTEM_TYPES = frozenset({"ext4", "xfs", "btrfs"})
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
DEVICE_RE = re.compile(r"(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)\Z")
ALIAS_RE = re.compile(re.escape(WSL_ALIAS) + r"Ubuntu2/([0-9a-f]{64})\Z")
PROOF_FIELDS = {
    "schema", "decision", "alias", "local_root", "protected_devices",
    "root_device", "root_inode", "root_stat_before", "root_stat_after",
    "mountinfo_sha256_before", "mountinfo_sha256_after", "mounts", "proof_sha256",
}
ROOT_STAT_FIELDS = {"device", "inode", "mode", "nlink", "mtime_ns", "ctime_ns"}
MOUNT_FIELDS = {
    "mount_id", "parent_id", "device", "root", "mountpoint",
    "filesystem_type", "source_sha256",
}


def _fail(message: str) -> None:
    raise BuildControlError("Local filesystem alias proof failed: " + message)


def _safe_alias_path(alias: object) -> tuple[str, Path]:
    if not isinstance(alias, str):
        _fail("alias is not a string")
    match = ALIAS_RE.fullmatch(alias)
    if match is None:
        _fail("alias is not the canonical Ubuntu2 hash root")
    local_root = LOCAL_ALIAS_ROOT / match.group(1)
    if not local_root.is_absolute() or ".." in local_root.parts:
        _fail("mapped local alias root is not canonical")
    return alias, local_root


def _protected_devices(values: object) -> tuple[int, ...]:
    if isinstance(values, (str, bytes, Mapping)) or not isinstance(values, Iterable):
        _fail("protected device set is malformed")
    result = []
    for value in values:
        if type(value) is not int or value < 0 or value > 2**64 - 1:
            _fail("protected device identity is not a strict nonnegative integer")
        result.append(value)
    if not result:
        _fail("protected device set is empty")
    return tuple(sorted(set(result)))


def _device_text(device: int) -> str:
    return str(os.major(device)) + ":" + str(os.minor(device))


def _validate_root_stat(record: Mapping[str, object]) -> dict[str, int]:
    if set(record) != ROOT_STAT_FIELDS:
        _fail("root stat fields differ")
    if any(type(item) is not int for item in record.values()):
        _fail("root stat contains a non-integer field")
    is_directory = stat.S_ISDIR(record["mode"])
    is_file = stat.S_ISREG(record["mode"])
    if (record["device"] < 0 or record["device"] > 2**64 - 1
            or record["inode"] <= 0 or record["inode"] > 2**64 - 1
            or not (is_directory or is_file)
            or record["nlink"] <= 0 or record["nlink"] > 2**63 - 1
            or (is_file and record["nlink"] != 1)
            or record["mtime_ns"] < -(2**63) or record["mtime_ns"] > 2**63 - 1
            or record["ctime_ns"] < -(2**63) or record["ctime_ns"] > 2**63 - 1):
        _fail("alias root is not a stable directory identity")
    return dict(record)


def _stat_record(value) -> dict[str, int]:
    return _validate_root_stat({
        "device": value.st_dev,
        "inode": value.st_ino,
        "mode": value.st_mode,
        "nlink": value.st_nlink,
        "mtime_ns": value.st_mtime_ns,
        "ctime_ns": value.st_ctime_ns,
    })


def _read_mountinfo() -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(MOUNTINFO_PATH, flags)
    except OSError as error:
        raise BuildControlError("Local filesystem alias proof failed: cannot open mountinfo") from error
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            _fail("kernel mountinfo is not a regular proc record")
        content = bytearray()
        while True:
            chunk = os.read(fd, min(65536, MAX_MOUNTINFO_BYTES + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
            if len(content) > MAX_MOUNTINFO_BYTES:
                _fail("kernel mountinfo exceeds its byte bound")
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_mode, before.st_nlink) != (
                after.st_dev, after.st_ino, after.st_mode, after.st_nlink):
            _fail("kernel mountinfo file identity changed while reading")
        raw = bytes(content)
        if (not raw or not raw.endswith(b"\n") or b"\0" in raw
                or len(raw.splitlines()) > 65536):
            _fail("kernel mountinfo framing or row count is invalid")
        return raw
    except BuildControlError:
        raise
    except (OSError, ValueError, UnicodeError) as error:
        raise BuildControlError("Local filesystem alias proof failed: malformed kernel mountinfo") from error
    finally:
        os.close(fd)


def _mount_attributes(raw: bytes, candidate_mount_ids: set[int]) -> dict[int, dict[str, str]]:
    candidates = set(candidate_mount_ids)
    attributes = {}
    for line in raw[:-1].split(b"\n"):
        fields = line.split(b" ")
        try:
            separator = next(index for index in range(6, len(fields)) if fields[index] == b"-")
            mount_id = int(fields[0].decode("ascii", "strict"))
            if mount_id not in candidates:
                continue
            filesystem_type = fields[separator + 1].decode("ascii", "strict").lower()
            source = bind_probe._decode_mountinfo_path(fields[separator + 2])
        except (StopIteration, IndexError, ValueError, UnicodeError) as error:
            raise BuildControlError("Local filesystem alias proof failed: mount source metadata is malformed") from error
        if mount_id in attributes:
            _fail("kernel mountinfo repeats a mount identity")
        if filesystem_type not in FILESYSTEM_TYPES:
            _fail("candidate mount uses an unverified filesystem type")
        if (not source or len(source.encode("utf-8")) > 4096
                or any(unicodedata.category(char) == "Cc" for char in source)
                or "\\" in source or source.startswith("//")
                or not (source.startswith("/") or source.startswith(("UUID=", "PARTUUID=", "LABEL=")))):
            _fail("candidate mount source is not a local Linux filesystem identity")
        attributes[mount_id] = {
            "filesystem_type": filesystem_type,
            "source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        }
    if set(attributes) != candidates:
        _fail("candidate mount source identities do not match parsed mount rows")
    return attributes


def _root_fd(path: Path) -> int:
    try:
        path_stat = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise BuildControlError("Local filesystem alias proof failed: alias root is missing") from error
    if stat.S_ISLNK(path_stat.st_mode):
        _fail("alias root is a symlink")
    if not (stat.S_ISDIR(path_stat.st_mode)
            or (stat.S_ISREG(path_stat.st_mode) and path_stat.st_nlink == 1)):
        _fail("alias root is not a directory or single-link regular file")
    flags = getattr(os, "O_PATH", os.O_RDONLY) | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    if stat.S_ISDIR(path_stat.st_mode):
        flags |= os.O_DIRECTORY
    try:
        fd = os.open(path, flags)
    except OSError as error:
        raise BuildControlError("Local filesystem alias proof failed: cannot pin alias root") from error
    try:
        opened = _stat_record(os.fstat(fd))
        observed = _stat_record(path_stat)
        if opened != observed:
            _fail("alias root changed while opening")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _stat_path(path: Path) -> dict[str, int]:
    try:
        value = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise BuildControlError("Local filesystem alias proof failed: alias root disappeared") from error
    if stat.S_ISLNK(value.st_mode):
        _fail("alias root changed to a symlink")
    return _stat_record(value)


def _alias_mountinfo(raw: bytes, local_root: str) -> bytes:
    """Select the Linux alias closure before parsing filesystem-specific roots.

    Other mounts may legitimately have Windows/UNC root names. Their kernel
    mountpoints are inspected for membership; their backing roots are opaque.
    """
    selected = []
    prefix = local_root.rstrip("/") + "/"
    for line in raw[:-1].split(b"\n"):
        fields = line.split(b" ")
        if len(fields) < 10:
            _fail("kernel mountinfo row is incomplete")
        point = bind_probe._decode_mountinfo_path(fields[4])
        if not point.startswith("/") or posixpath.normpath(point) != point:
            _fail("kernel mountpoint is not canonical")
        if point == local_root or point.startswith(prefix):
            selected.append(line)
    return b"\n".join(selected) + b"\n" if selected else b""


def _candidate_rows(raw: bytes, local_root: str) -> list[dict[str, object]]:
    selected_raw = _alias_mountinfo(raw, local_root)
    parsed = bind_probe._parse_mountinfo(selected_raw)
    prefix = local_root.rstrip("/") + "/"
    candidates = [row for row in parsed
                  if row["mountpoint"] == local_root or row["mountpoint"].startswith(prefix)]
    if not candidates or len(candidates) > MAX_ALIAS_MOUNTS:
        _fail("alias mount closure is missing or exceeds its bound")
    mountpoints = [row["mountpoint"] for row in candidates]
    if len(mountpoints) != len(set(mountpoints)):
        _fail("alias mount closure has duplicate mountpoints")
    if sum(row["mountpoint"] == local_root for row in candidates) != 1:
        _fail("alias root has no unique direct mount record")
    attributes = _mount_attributes(selected_raw, {row["mount_id"] for row in candidates})
    result = []
    for row in sorted(candidates, key=lambda item: (item["mountpoint"], item["mount_id"])):
        details = attributes[row["mount_id"]]
        result.append({**row, **details})
    return result


def _proof_body(proof: Mapping[str, object]) -> dict[str, object]:
    return {key: value for key, value in proof.items() if key != "proof_sha256"}


def proof_sha256(proof: Mapping[str, object]) -> str:
    return hashlib.sha256(canonical(_proof_body(proof))).hexdigest()


def validate_proof(proof: object) -> dict[str, object]:
    if not isinstance(proof, Mapping) or set(proof) != PROOF_FIELDS:
        _fail("proof fields differ from the closed schema")
    if proof.get("schema") != PROOF_SCHEMA or proof.get("decision") != "disjoint":
        _fail("proof schema or decision differs")
    alias, local_path = _safe_alias_path(proof.get("alias"))
    if proof.get("local_root") != str(local_path):
        _fail("proof local alias mapping differs")
    protected = _protected_devices(proof.get("protected_devices"))
    if list(protected) != proof.get("protected_devices"):
        _fail("proof protected device list is not canonical")
    root_device, root_inode = proof.get("root_device"), proof.get("root_inode")
    if (type(root_device) is not int or root_device < 0 or root_device > 2**64 - 1
            or type(root_inode) is not int or root_inode <= 0 or root_inode > 2**64 - 1):
        _fail("proof root device or inode is malformed")
    root_stat_before = proof.get("root_stat_before")
    root_stat_after = proof.get("root_stat_after")
    if (not isinstance(root_stat_before, Mapping) or set(root_stat_before) != ROOT_STAT_FIELDS
            or not isinstance(root_stat_after, Mapping) or set(root_stat_after) != ROOT_STAT_FIELDS):
        _fail("proof root stat fields differ")
    normalized_before = _validate_root_stat(root_stat_before)
    normalized_after = _validate_root_stat(root_stat_after)
    if (normalized_before != normalized_after or normalized_before != dict(root_stat_before)
            or normalized_after != dict(root_stat_after)
            or root_stat_before["device"] != root_device or root_stat_before["inode"] != root_inode):
        _fail("proof root stat identity differs")
    before_sha, after_sha = proof.get("mountinfo_sha256_before"), proof.get("mountinfo_sha256_after")
    if (not isinstance(before_sha, str) or SHA256_RE.fullmatch(before_sha) is None
            or before_sha != after_sha):
        _fail("proof mountinfo snapshots are malformed or changed")
    mounts = proof.get("mounts")
    if not isinstance(mounts, list) or not mounts or len(mounts) > MAX_ALIAS_MOUNTS:
        _fail("proof mount closure is malformed")
    device = _device_text(root_device)
    if sum(isinstance(row, Mapping) and row.get("mountpoint") == str(local_path) for row in mounts) != 1:
        _fail("proof has no unique direct root mount")
    prefix = str(local_path).rstrip("/") + "/"
    mountpoints = []
    protected_text = {_device_text(item) for item in protected}
    for row in mounts:
        if not isinstance(row, Mapping) or set(row) != MOUNT_FIELDS:
            _fail("proof mount row fields differ")
        if (type(row.get("mount_id")) is not int or row["mount_id"] <= 0
                or type(row.get("parent_id")) is not int or row["parent_id"] < 0
                or not isinstance(row.get("device"), str) or DEVICE_RE.fullmatch(row["device"]) is None
                or row.get("filesystem_type") not in FILESYSTEM_TYPES
                or not isinstance(row.get("source_sha256"), str)
                or SHA256_RE.fullmatch(row["source_sha256"]) is None):
            _fail("proof mount identity is malformed")
        try:
            bind_probe._safe_mount_path(row.get("root"))
            mountpoint = bind_probe._safe_mount_path(row.get("mountpoint"))
        except (TypeError, ValueError) as error:
            raise BuildControlError("Local filesystem alias proof failed: proof mount path is unsafe") from error
        if mountpoint != str(local_path) and not mountpoint.startswith(prefix):
            _fail("proof mountpoint escapes its alias root")
        if row["device"] in protected_text:
            _fail("proof closure includes a protected device")
        if mountpoint == str(local_path) and row["device"] != device:
            _fail("proof root stat device differs from its direct mount")
        mountpoints.append(mountpoint)
    if len(mountpoints) != len(set(mountpoints)):
        _fail("proof contains duplicate mountpoints")
    if proof.get("proof_sha256") != proof_sha256(proof):
        _fail("proof digest differs")
    return dict(proof)


def prove_alias(alias: str, protected_devices: Iterable[int]) -> dict[str, object] | None:
    """Return a typed proof for a separate local alias filesystem, or None.

    ``None`` means the alias root itself shares a protected device and must be
    handled by the caller's existing canonical-path proof. Unsafe, drifting,
    unsupported, or partially overlapping evidence raises ``BuildControlError``.
    """
    alias, local_path = _safe_alias_path(alias)
    protected = _protected_devices(protected_devices)
    try:
        local_root = str(local_path)
        mountinfo_before = _read_mountinfo()
        fd = _root_fd(local_path)
    except BuildControlError:
        raise
    try:
        root_before = _stat_record(os.fstat(fd))
        rows = _candidate_rows(mountinfo_before, local_root)
        direct = next(row for row in rows if row["mountpoint"] == local_root)
        if stat.S_ISREG(root_before["mode"]) and len(rows) != 1:
            _fail("regular-file alias root has nested mounts")
        device = _device_text(root_before["device"])
        if direct["device"] != device:
            _fail("alias root stat device differs from its direct mount")
        protected_text = {_device_text(item) for item in protected}
        for row in rows:
            if row["mountpoint"] != local_root and row["device"] in protected_text:
                _fail("nested alias mount uses a protected device")
        mountinfo_after = _read_mountinfo()
        root_after = _stat_record(os.fstat(fd))
        path_after = _stat_path(local_path)
        if root_before != root_after or root_before != path_after:
            _fail("alias root stat changed during its proof")
        if mountinfo_before != mountinfo_after:
            _fail("kernel mountinfo changed during its proof")
        if root_before["device"] in protected:
            return None
        if any(row["device"] in protected_text for row in rows):
            _fail("alias mount closure uses a protected device")
        before_sha = hashlib.sha256(mountinfo_before).hexdigest()
        after_sha = hashlib.sha256(mountinfo_after).hexdigest()
        proof = {
            "schema": PROOF_SCHEMA,
            "decision": "disjoint",
            "alias": alias,
            "local_root": local_root,
            "protected_devices": list(protected),
            "root_device": root_before["device"],
            "root_inode": root_before["inode"],
            "root_stat_before": root_before,
            "root_stat_after": root_after,
            "mountinfo_sha256_before": before_sha,
            "mountinfo_sha256_after": after_sha,
            "mounts": rows,
        }
        proof["proof_sha256"] = proof_sha256(proof)
        return validate_proof(proof)
    finally:
        os.close(fd)
