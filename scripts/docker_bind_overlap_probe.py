"""Prove a foreign Docker Desktop bind is disjoint from one pinned store.

The only filesystem observation happens in one unprivileged, read-only Python
process in the exact immutable image of the stopped Fullmag backend.  It uses
the container kernel's mountinfo roots and device numbers, never guessed
Desktop alias names or foreign application processes.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import unicodedata
import uuid
from collections.abc import Mapping
from pathlib import PurePosixPath

from docker_build_control import BuildControlError, bounded_capture, canonical, docker_capture
import docker_dev_host
from docker_foreign_bind_identity import WSL_ALIAS
import docker_wsl_bind


PROBE_SCHEMA = "fullmag.docker-bind-overlap-probe.v1"
PROOF_SCHEMA = "fullmag.docker-bind-overlap-proof.v1"
FOREIGN_PROOF_SCHEMA = "fullmag.foreign-bind-disjoint-proof.v1"
WORKTREE_FOREIGN_PROOF_SCHEMA = "fullmag.worktree-foreign-bind-disjoint-proof.v1"
OWNER_MARKER = ".fullmag-linux-native-owner.json"
MAX_MARKER_BYTES = 1024 * 1024
MAX_MOUNTINFO_BYTES = 4 * 1024 * 1024
MAX_MOUNTINFO_RECORDS = 8192
MAX_PROBE_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_FOREIGN_LIFECYCLE_PROOFS = 3
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_DEVICE = re.compile(r"(0|[1-9][0-9]*):(0|[1-9][0-9]*)\Z")
_MOUNT_ROW_FIELDS = {"mount_id", "parent_id", "device", "root", "mountpoint"}
_PROBE_FIELDS = {
    "schema", "decision", "reference_marker", "reference_stat",
    "reference_mount", "candidate_mounts", "mountinfo_sha256_before",
    "mountinfo_sha256_after", "candidate_stat_before", "candidate_stat_after",
}
_CANDIDATE_STAT_FIELDS = {
    "device", "inode", "type", "nlink", "size", "mode", "mtime_ns", "ctime_ns",
}
_FOREIGN_PROOF_FIELDS = {
    "schema", "decision", "container_id", "image_id", "started_at", "status",
    "running", "pid", "inspection_sha256", "candidate_alias_sha256",
    "reference_root_sha256", "kernel_proof",
}
_WORKTREE_FOREIGN_PROOF_FIELDS = _FOREIGN_PROOF_FIELDS | {"worktree_context"}
_WORKTREE_CONTEXT_FIELDS = {
    "compose_project", "worktree_id", "source_project_id", "source_root_sha256",
    "compose_sha256", "backend_container_id", "backend_image_id", "control_volume",
    "control_namespace", "ledger_volume", "ledger_subpath", "reference_root_sha256",
    "reference_device", "reference_inode", "engine_id", "certificate_sha256",
    "owner_marker_sha256",
}
_KERNEL_PROOF_FIELDS = {
    "schema", "decision", "probe_schema", "candidate_alias_sha256",
    "reference_root_sha256", "reference_marker_sha256", "reference_marker_size",
    "reference_marker_stat", "reference_stat", "reference_mount", "candidate_mounts",
    "candidate_stat", "mountinfo_sha256",
}


def _decode_mountinfo_path(raw):
    """Decode the four kernel mountinfo escapes and reject ambiguous ones."""
    if not isinstance(raw, bytes):
        raise ValueError("mountinfo path field is not bytes")
    escapes = {b"040": 0x20, b"011": 0x09, b"012": 0x0A, b"134": 0x5C}
    decoded = bytearray()
    offset = 0
    while offset < len(raw):
        value = raw[offset]
        if value == 0x5C:
            code = raw[offset + 1:offset + 4]
            if len(code) != 3 or code not in escapes:
                raise ValueError("mountinfo path has an unknown or truncated escape")
            decoded.append(escapes[code])
            offset += 4
        else:
            decoded.append(value)
            offset += 1
    try:
        return decoded.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        raise ValueError("mountinfo path is not UTF-8") from error


def _safe_mount_path(value):
    """Require one normalized absolute POSIX path without traversal/control."""
    if (not isinstance(value, str) or not value.startswith("/")
            or value.startswith("//") or len(value.encode("utf-8")) > 4096
            or any(unicodedata.category(character) == "Cc" for character in value)
            or any(part in {".", ".."} for part in value.split("/"))):
        raise ValueError("mountinfo contains an unsafe path")
    import posixpath
    if posixpath.normpath(value) != value:
        raise ValueError("mountinfo path is not normalized")
    return value


def _parse_mountinfo(raw):
    """Parse a bounded kernel mountinfo snapshot into safe mount identities."""
    if (not isinstance(raw, bytes) or not raw or len(raw) > MAX_MOUNTINFO_BYTES
            or not raw.endswith(b"\n") or b"\r" in raw or b"\x00" in raw):
        raise ValueError("mountinfo snapshot is empty, malformed or over budget")
    lines = raw[:-1].split(b"\n")
    if not lines or len(lines) > MAX_MOUNTINFO_RECORDS:
        raise ValueError("mountinfo record count is invalid or over budget")
    result = []
    mount_ids = set()
    for line in lines:
        if (not line or len(line) > 16 * 1024
                or any(value < 0x20 or value == 0x7F for value in line)):
            raise ValueError("mountinfo record is empty, overlong or contains controls")
        fields = line.split(b" ")
        if len(fields) < 10 or any(not field for field in fields):
            raise ValueError("mountinfo record has malformed fields")
        separators = [index for index in range(6, len(fields)) if fields[index] == b"-"]
        if not separators:
            raise ValueError("mountinfo record has no filesystem separator")
        separator = separators[0]
        if len(fields) - separator < 4:
            raise ValueError("mountinfo filesystem fields are incomplete")
        if re.fullmatch(rb"[A-Za-z0-9_+=:,.+\-]+", fields[5]) is None:
            raise ValueError("mountinfo mount options are malformed")

        mount_id_raw, parent_id_raw = fields[0], fields[1]
        if (_DECIMAL.fullmatch(mount_id_raw.decode("ascii", "strict")) is None
                or _DECIMAL.fullmatch(parent_id_raw.decode("ascii", "strict")) is None):
            raise ValueError("mountinfo mount identifiers are malformed")
        mount_id, parent_id = int(mount_id_raw), int(parent_id_raw)
        if (mount_id <= 0 or mount_id > (2**63 - 1)
                or parent_id > (2**63 - 1) or mount_id in mount_ids):
            raise ValueError("mountinfo mount identifiers are unsafe or duplicated")
        mount_ids.add(mount_id)

        try:
            device_text = fields[2].decode("ascii", "strict")
        except UnicodeDecodeError as error:
            raise ValueError("mountinfo device is not ASCII") from error
        match = _DEVICE.fullmatch(device_text)
        if match is None:
            raise ValueError("mountinfo device major:minor is malformed")
        major, minor = int(match[1]), int(match[2])
        if major > (2**32 - 1) or minor > (2**32 - 1):
            raise ValueError("mountinfo device major:minor is out of range")

        root = _safe_mount_path(_decode_mountinfo_path(fields[3]))
        mountpoint = _safe_mount_path(_decode_mountinfo_path(fields[4]))
        if not fields[separator + 1] or not fields[separator + 2] or not fields[separator + 3]:
            raise ValueError("mountinfo filesystem identity is incomplete")
        result.append({"mount_id": mount_id, "parent_id": parent_id,
                       "device": f"{major}:{minor}", "root": root,
                       "mountpoint": mountpoint})
    return result


def _path_roots_overlap(left, right):
    if left == right or left == "/" or right == "/":
        return True
    left_prefix = left.rstrip("/") + "/"
    right_prefix = right.rstrip("/") + "/"
    return left.startswith(right_prefix) or right.startswith(left_prefix)


def _classify_mount_rows(reference_mount, candidate_mounts, reference_device):
    """Prove all candidate mount roots disjoint on the reference device."""
    if (type(reference_device) is not int or reference_device < 0
            or reference_device > 2**64 - 1):
        raise ValueError("reference stat device is not a strict nonnegative integer")
    expected_device = f"{os.major(reference_device)}:{os.minor(reference_device)}"
    if reference_mount["device"] != expected_device:
        raise ValueError("reference stat device differs from its kernel mountinfo record")
    if reference_mount["mountpoint"] != "/reference":
        raise ValueError("probe has no exact reference mount record")
    if not candidate_mounts or sum(row["mountpoint"] == "/candidate"
                                   for row in candidate_mounts) != 1:
        raise ValueError("probe has no unique exact candidate mount record")
    mountpoints = [row["mountpoint"] for row in candidate_mounts]
    if len(set(mountpoints)) != len(mountpoints):
        raise ValueError("candidate has duplicate kernel mountpoints")
    for row in candidate_mounts:
        point = row["mountpoint"]
        if point != "/candidate" and not point.startswith("/candidate/"):
            raise ValueError("candidate mount record escapes the candidate tree")
        if row["device"] != reference_mount["device"]:
            raise ValueError("candidate mount device differs; disjointness is unknown")
        if _path_roots_overlap(reference_mount["root"], row["root"]):
            raise ValueError("candidate mount root overlaps the retained reference store")
    return {"decision": "disjoint", "reference_mount": reference_mount,
            "candidate_mounts": candidate_mounts}


def _classify_mountinfo(raw, reference_device):
    """Pure parser/classifier exposed for deterministic kernel-record tests."""
    records = _parse_mountinfo(raw)
    reference_rows = [row for row in records if row["mountpoint"] == "/reference"]
    reference_submounts = [row for row in records
                           if row["mountpoint"].startswith("/reference/")]
    candidate_mounts = sorted(
        [row for row in records if row["mountpoint"] == "/candidate"
         or row["mountpoint"].startswith("/candidate/")],
        key=lambda row: (row["mountpoint"], row["mount_id"]),
    )
    if len(reference_rows) != 1:
        raise ValueError("mountinfo has no unique exact reference mount")
    if reference_submounts:
        raise ValueError("reference subtree has a nested mount; disjointness is unknown")
    if not candidate_mounts:
        raise ValueError("mountinfo has no candidate mount records")
    return _classify_mount_rows(reference_rows[0], candidate_mounts, reference_device)


def _candidate_stat_identity(metadata, expected_mount_device):
    """Normalize metadata-only O_PATH stat and bind it to the kernel mount row."""
    values = {
        "device": metadata.st_dev,
        "inode": metadata.st_ino,
        "nlink": metadata.st_nlink,
        "size": metadata.st_size,
        "mode": metadata.st_mode,
        "mtime_ns": metadata.st_mtime_ns,
        "ctime_ns": metadata.st_ctime_ns,
    }
    if any(type(value) is not int for value in values.values()):
        raise ValueError("candidate stat contains a non-integer value")
    if (values["device"] < 0 or values["device"] > 2**64 - 1
            or values["inode"] <= 0 or values["inode"] > 2**64 - 1
            or values["nlink"] <= 0 or values["nlink"] > 2**63 - 1
            or values["size"] < 0 or values["size"] > 2**63 - 1
            or values["mode"] < 0 or values["mode"] > 2**32 - 1
            or values["mtime_ns"] < -(2**63) or values["mtime_ns"] > 2**63 - 1
            or values["ctime_ns"] < -(2**63) or values["ctime_ns"] > 2**63 - 1):
        raise ValueError("candidate stat value is out of range")
    if not isinstance(expected_mount_device, str) or _DEVICE.fullmatch(expected_mount_device) is None:
        raise ValueError("candidate mount device is malformed")
    observed_device = str(os.major(values["device"])) + ":" + str(os.minor(values["device"]))
    if observed_device != expected_mount_device:
        raise ValueError("candidate stat device differs from its kernel mountinfo record")
    if stat.S_ISDIR(values["mode"]):
        kind = "directory"
    elif stat.S_ISREG(values["mode"]):
        kind = "regular-file"
        if values["nlink"] != 1:
            raise ValueError("candidate regular file has multiple links")
    else:
        raise ValueError("candidate is neither a directory nor a regular file")
    return {**values, "type": kind}


def _candidate_identity(mount):
    """Observe candidate metadata without opening or reading its contents."""
    fd = os.open("/candidate", os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        return _candidate_stat_identity(os.fstat(fd), mount["device"])
    finally:
        os.close(fd)


def _probe_source():
    pieces = [
        "import hashlib, json, os, re, signal, stat, sys, unicodedata\n",
        f"MAX_MARKER_BYTES = {MAX_MARKER_BYTES}\n",
        f"MAX_MOUNTINFO_BYTES = {MAX_MOUNTINFO_BYTES}\n",
        f"MAX_MOUNTINFO_RECORDS = {MAX_MOUNTINFO_RECORDS}\n",
        f"OWNER_MARKER = {OWNER_MARKER!r}\n",
        f"PROBE_SCHEMA = {PROBE_SCHEMA!r}\n",
        f"_DECIMAL = re.compile({_DECIMAL.pattern!r})\n",
        f"_DEVICE = re.compile({_DEVICE.pattern!r})\n",
    ]
    pieces.extend(inspect.getsource(function) + "\n" for function in (
        _decode_mountinfo_path, _safe_mount_path, _parse_mountinfo,
        _path_roots_overlap, _classify_mount_rows, _classify_mountinfo,
        _candidate_stat_identity, _candidate_identity,
    ))
    pieces.append(r'''
signal.alarm(35)
def regular_stat_tuple(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_mode, value.st_nlink)
def root_stat_tuple(value):
    return (value.st_dev, value.st_ino, value.st_mtime_ns,
            value.st_ctime_ns, value.st_mode)
def read_reference():
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    root_fd = os.open('/reference', flags)
    try:
        root_before = os.fstat(root_fd)
        if not stat.S_ISDIR(root_before.st_mode):
            raise ValueError('reference root is not a directory')
        marker_fd = os.open(OWNER_MARKER,
                            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=root_fd)
        try:
            marker_before = os.fstat(marker_fd)
            if (not stat.S_ISREG(marker_before.st_mode)
                    or marker_before.st_size <= 0
                    or marker_before.st_size > MAX_MARKER_BYTES):
                raise ValueError('reference owner marker is not a bounded regular file')
            content = bytearray()
            while True:
                chunk = os.read(marker_fd, min(65536, MAX_MARKER_BYTES + 1 - len(content)))
                if not chunk:
                    break
                content.extend(chunk)
                if len(content) > MAX_MARKER_BYTES:
                    raise ValueError('reference owner marker exceeds its byte budget')
            marker_after = os.fstat(marker_fd)
            marker_path_after = os.stat(OWNER_MARKER, dir_fd=root_fd,
                                       follow_symlinks=False)
            if (regular_stat_tuple(marker_before) != regular_stat_tuple(marker_after)
                    or regular_stat_tuple(marker_before) != regular_stat_tuple(marker_path_after)
                    or len(content) != marker_before.st_size):
                raise ValueError('reference owner marker changed while being read')
        finally:
            os.close(marker_fd)
        root_after = os.fstat(root_fd)
        if root_stat_tuple(root_before) != root_stat_tuple(root_after):
            raise ValueError('reference root changed while being read')
        if marker_before.st_dev != root_before.st_dev:
            raise ValueError('reference owner marker is on a nested filesystem')
        return {
            'marker_sha256': hashlib.sha256(content).hexdigest(),
            'marker_size': len(content),
            'marker_device': marker_before.st_dev,
            'marker_inode': marker_before.st_ino,
            'reference_device': root_before.st_dev,
            'reference_inode': root_before.st_ino,
            'root_stat_tuple': root_stat_tuple(root_before),
            'marker_stat_tuple': regular_stat_tuple(marker_before),
        }
    finally:
        os.close(root_fd)
def read_mountinfo():
    fd = os.open('/proc/self/mountinfo', os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        content = bytearray()
        while True:
            chunk = os.read(fd, min(65536, MAX_MOUNTINFO_BYTES + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
            if len(content) > MAX_MOUNTINFO_BYTES:
                raise ValueError('mountinfo exceeds its byte budget')
        return bytes(content)
    finally:
        os.close(fd)
def same_reference(left, right):
    return all(left[key] == right[key] for key in (
        'marker_sha256', 'marker_size', 'marker_device', 'marker_inode',
        'reference_device', 'reference_inode', 'root_stat_tuple', 'marker_stat_tuple'))
def main():
    request = json.load(sys.stdin.buffer)
    if (not isinstance(request, dict) or set(request) != {'reference_marker_sha256'}
            or not isinstance(request['reference_marker_sha256'], str)
            or re.fullmatch(r'[0-9a-f]{64}', request['reference_marker_sha256']) is None):
        raise ValueError('probe request is malformed')
    expected = request['reference_marker_sha256']
    reference_before = read_reference()
    if reference_before['marker_sha256'] != expected:
        raise ValueError('reference owner marker SHA-256 differs')
    mountinfo_before = read_mountinfo()
    proof = _classify_mountinfo(mountinfo_before, reference_before['reference_device'])
    exact_candidates = [row for row in proof['candidate_mounts']
                        if row['mountpoint'] == '/candidate']
    if len(exact_candidates) != 1:
        raise ValueError('candidate exact mount record is not unique')
    candidate_stat_before = _candidate_identity(exact_candidates[0])
    if (candidate_stat_before['type'] == 'regular-file'
            and len(proof['candidate_mounts']) != 1):
        raise ValueError('regular-file candidate has nested mount records')
    candidate_stat_after = _candidate_identity(exact_candidates[0])
    mountinfo_after = read_mountinfo()
    reference_after = read_reference()
    if (not same_reference(reference_before, reference_after)
            or mountinfo_before != mountinfo_after
            or candidate_stat_before != candidate_stat_after):
        raise ValueError('reference, candidate stat or mountinfo drifted during proof')
    result = {
        'schema': PROBE_SCHEMA,
        'decision': 'disjoint',
        'reference_marker': {
            'sha256': reference_before['marker_sha256'],
            'size': reference_before['marker_size'],
            'device': reference_before['marker_device'],
            'inode': reference_before['marker_inode'],
        },
        'reference_stat': {
            'device': reference_before['reference_device'],
            'inode': reference_before['reference_inode'],
        },
        'reference_mount': proof['reference_mount'],
        'candidate_mounts': proof['candidate_mounts'],
        'candidate_stat_before': candidate_stat_before,
        'candidate_stat_after': candidate_stat_after,
        'mountinfo_sha256_before': hashlib.sha256(mountinfo_before).hexdigest(),
        'mountinfo_sha256_after': hashlib.sha256(mountinfo_after).hexdigest(),
    }
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(',', ':')))
main()
''')
    return "".join(pieces)


PROBE_SOURCE = _probe_source()


def _reject_duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("probe JSON contains a duplicate key")
        value[key] = item
    return value


def _sha256(value, label):
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None or value == "0" * 64:
        raise BuildControlError(label + " must be a non-placeholder lowercase SHA-256")
    return value


def _strict_int(value, label, *, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError(label + " must be a strict integer")
    return value


def _canonical_reference_root(value):
    try:
        raw_path = os.fspath(value)
        if not isinstance(raw_path, str):
            raise ValueError("reference_root is not text")
        root = Path(value)
    except (TypeError, ValueError, OSError) as error:
        raise BuildControlError("reference_root is not a filesystem path") from error
    if (not root.is_absolute() or str(root).startswith("//") or ".." in root.parts
            or raw_path != os.path.normpath(raw_path)
            or str(root) != os.path.normpath(str(root))):
        raise BuildControlError("reference_root must be a normalized absolute path")
    try:
        root_text = str(root)
        root_text.encode("utf-8", "strict")
    except UnicodeEncodeError as error:
        raise BuildControlError("reference_root is not valid UTF-8 text") from error
    if "," in root_text or "\\" in root_text or any(ord(char) < 0x20 or ord(char) == 0x7F
                                                    for char in root_text):
        raise BuildControlError("reference_root cannot be represented as a safe Docker bind")
    try:
        for ancestor in (root, *root.parents):
            if stat.S_ISLNK(os.lstat(ancestor).st_mode):
                raise BuildControlError("reference_root traverses a symlink")
        resolved = root.resolve(strict=True)
        root_stat = os.lstat(root)
    except OSError as error:
        raise BuildControlError("reference_root is unavailable") from error
    if resolved != root or not stat.S_ISDIR(root_stat.st_mode):
        raise BuildControlError("reference_root is not a canonical real directory")
    return root


def _host_reference_identity(root):
    """Read the owner marker via no-follow descriptors and pin its root."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        root_fd = os.open(root, flags)
    except OSError as error:
        raise BuildControlError("reference_root cannot be opened without following links") from error
    try:
        before_root = os.fstat(root_fd)
        if not stat.S_ISDIR(before_root.st_mode):
            raise BuildControlError("reference_root is not a directory")
        try:
            marker_fd = os.open(OWNER_MARKER,
                                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=root_fd)
        except OSError as error:
            raise BuildControlError("reference owner marker cannot be opened without following links") from error
        try:
            before_marker = os.fstat(marker_fd)
            if (not stat.S_ISREG(before_marker.st_mode) or before_marker.st_size <= 0
                    or before_marker.st_size > MAX_MARKER_BYTES):
                raise BuildControlError("reference owner marker is not a bounded regular file")
            content = bytearray()
            while True:
                chunk = os.read(marker_fd, min(65536, MAX_MARKER_BYTES + 1 - len(content)))
                if not chunk:
                    break
                content.extend(chunk)
                if len(content) > MAX_MARKER_BYTES:
                    raise BuildControlError("reference owner marker exceeds its byte budget")
            after_marker = os.fstat(marker_fd)
            marker_path = os.stat(OWNER_MARKER, dir_fd=root_fd, follow_symlinks=False)
            if (len(content) != before_marker.st_size
                    or _stat_record(before_marker) != _stat_record(after_marker)
                    or _stat_record(before_marker) != _stat_record(marker_path)):
                raise BuildControlError("reference owner marker changed while being read")
        finally:
            os.close(marker_fd)
        after_root = os.fstat(root_fd)
        if _root_stat_record(before_root) != _root_stat_record(after_root):
            raise BuildControlError("reference root changed while being read")
        if before_marker.st_dev != before_root.st_dev:
            raise BuildControlError("reference owner marker is on a nested filesystem")
        return {
            "marker_sha256": hashlib.sha256(content).hexdigest(),
            "marker_size": len(content),
            "root_device": before_root.st_dev,
            "root_inode": before_root.st_ino,
            "root_stat": _root_stat_record(before_root),
            "marker_device": before_marker.st_dev,
            "marker_inode": before_marker.st_ino,
            "marker_stat": _stat_record(before_marker),
        }
    except OSError as error:
        raise BuildControlError("reference owner marker observation failed") from error
    finally:
        os.close(root_fd)


def _stat_record(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, value.st_mode, value.st_nlink)


def _root_stat_record(value):
    return (value.st_dev, value.st_ino, value.st_mtime_ns,
            value.st_ctime_ns, value.st_mode)


def _validate_mount_row(value, label):
    if not isinstance(value, dict) or set(value) != _MOUNT_ROW_FIELDS:
        raise ValueError(label + " mount row has an invalid schema")
    mount_id = _strict_int(value.get("mount_id"), label + " mount_id", minimum=1)
    parent_id = _strict_int(value.get("parent_id"), label + " parent_id")
    if mount_id > 2**63 - 1 or parent_id > 2**63 - 1:
        raise ValueError(label + " mount identifier is out of range")
    device = value.get("device")
    match = _DEVICE.fullmatch(device) if isinstance(device, str) else None
    if match is None or any(int(match[index]) > 2**32 - 1 for index in (1, 2)):
        raise ValueError(label + " mount device is malformed")
    root = _safe_mount_path(value.get("root"))
    mountpoint = _safe_mount_path(value.get("mountpoint"))
    return {"mount_id": mount_id, "parent_id": parent_id, "device": device,
            "root": root, "mountpoint": mountpoint}


def _validate_candidate_stat(value, candidates, label):
    if not isinstance(value, dict) or set(value) != _CANDIDATE_STAT_FIELDS:
        raise ValueError(label + " candidate stat has an invalid schema")
    device = _strict_int(value.get("device"), label + " candidate device")
    inode = _strict_int(value.get("inode"), label + " candidate inode", minimum=1)
    nlink = _strict_int(value.get("nlink"), label + " candidate link count", minimum=1)
    size = _strict_int(value.get("size"), label + " candidate size")
    mode = _strict_int(value.get("mode"), label + " candidate mode")
    mtime_ns = value.get("mtime_ns")
    ctime_ns = value.get("ctime_ns")
    if type(mtime_ns) is not int or type(ctime_ns) is not int:
        raise ValueError(label + " candidate timestamps must be strict integers")
    if (device > 2**64 - 1 or inode > 2**64 - 1 or nlink > 2**63 - 1
            or size > 2**63 - 1 or mode > 2**32 - 1
            or mtime_ns < -(2**63) or mtime_ns > 2**63 - 1
            or ctime_ns < -(2**63) or ctime_ns > 2**63 - 1):
        raise ValueError(label + " candidate stat value is out of range")
    expected_device = f"{os.major(device)}:{os.minor(device)}"
    exact_candidates = [row for row in candidates if row["mountpoint"] == "/candidate"]
    if len(exact_candidates) != 1 or expected_device != exact_candidates[0]["device"]:
        raise ValueError(label + " candidate stat device differs from its exact mount record")
    kind = value.get("type")
    if (kind == "directory" and stat.S_ISDIR(mode)):
        pass
    elif kind == "regular-file" and stat.S_ISREG(mode):
        if nlink != 1:
            raise ValueError(label + " candidate regular file has multiple links")
        if len(candidates) != 1:
            raise ValueError(label + " regular-file candidate has nested mount records")
    else:
        raise ValueError(label + " candidate type is not a directory or regular file")
    return {"device": device, "inode": inode, "type": kind, "nlink": nlink,
            "size": size, "mode": mode, "mtime_ns": mtime_ns, "ctime_ns": ctime_ns}


def _validate_probe_result(raw, expected_marker_sha256, expected_marker_size):
    if not isinstance(raw, bytes) or len(raw) > MAX_PROBE_OUTPUT_BYTES:
        raise ValueError("probe output exceeds its byte budget")
    try:
        value = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError("probe output is not unambiguous UTF-8 JSON") from error
    if not isinstance(value, dict) or set(value) != _PROBE_FIELDS:
        raise ValueError("probe output fields differ from the frozen schema")
    if value.get("schema") != PROBE_SCHEMA or value.get("decision") != "disjoint":
        raise ValueError("probe did not return the exact disjoint proof schema")
    marker = value.get("reference_marker")
    if (not isinstance(marker, dict)
            or set(marker) != {"sha256", "size", "device", "inode"}
            or marker.get("sha256") != expected_marker_sha256
            or _strict_int(marker.get("size"), "reference marker size", minimum=1)
            != expected_marker_size):
        raise ValueError("probe reference marker does not match the selected store pin")
    marker_device = _strict_int(marker.get("device"), "reference marker device")
    if marker_device > 2**64 - 1:
        raise ValueError("reference marker device is out of range")
    marker_inode = _strict_int(marker.get("inode"), "reference marker inode", minimum=1)
    if marker_inode > 2**64 - 1:
        raise ValueError("reference marker inode is out of range")
    reference_stat = value.get("reference_stat")
    if (not isinstance(reference_stat, dict)
            or set(reference_stat) != {"device", "inode"}):
        raise ValueError("probe reference stat pin has an invalid schema")
    reference_device = _strict_int(reference_stat.get("device"), "reference stat device")
    if reference_device > 2**64 - 1:
        raise ValueError("reference stat device is out of range")
    reference_inode = _strict_int(reference_stat.get("inode"), "reference stat inode", minimum=1)
    if reference_inode > 2**64 - 1:
        raise ValueError("reference stat inode is out of range")
    if marker_device != reference_device:
        raise ValueError("probe owner marker is not on the reference root device")
    reference_mount = _validate_mount_row(value.get("reference_mount"), "reference")
    raw_candidates = value.get("candidate_mounts")
    if (not isinstance(raw_candidates, list) or not raw_candidates
            or len(raw_candidates) > MAX_MOUNTINFO_RECORDS):
        raise ValueError("probe candidate mount inventory is empty or over budget")
    candidates = [_validate_mount_row(row, "candidate") for row in raw_candidates]
    if candidates != sorted(candidates, key=lambda row: (row["mountpoint"], row["mount_id"])):
        raise ValueError("probe candidate mount inventory is not canonically ordered")
    mount_ids = [reference_mount["mount_id"], *(row["mount_id"] for row in candidates)]
    if len(set(mount_ids)) != len(mount_ids):
        raise ValueError("probe mount inventory has duplicate mount IDs")
    candidate_stat_before = _validate_candidate_stat(
        value.get("candidate_stat_before"), candidates, "before")
    candidate_stat_after = _validate_candidate_stat(
        value.get("candidate_stat_after"), candidates, "after")
    if candidate_stat_before != candidate_stat_after:
        raise ValueError("candidate stat changed during its proof")
    before_digest = value.get("mountinfo_sha256_before")
    after_digest = value.get("mountinfo_sha256_after")
    for digest in (before_digest, after_digest):
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None or digest == "0" * 64:
            raise ValueError("probe mountinfo raw digest is malformed")
    if before_digest != after_digest:
        raise ValueError("probe mountinfo changed during its proof")
    classification = _classify_mount_rows(reference_mount, candidates, reference_device)
    return {
        "schema": PROBE_SCHEMA,
        "decision": classification["decision"],
        "reference_marker_sha256": marker["sha256"],
        "reference_marker_size": marker["size"],
        "reference_marker_stat": {"device": marker_device, "inode": marker_inode},
        "reference_stat": reference_stat,
        "reference_mount": reference_mount,
        "candidate_mounts": candidates,
        "candidate_stat": candidate_stat_before,
        "mountinfo_sha256": before_digest,
    }


def _safe_alias(value):
    try:
        alias = docker_wsl_bind.safe_daemon_path(value)
    except (BuildControlError, TypeError) as error:
        raise BuildControlError("candidate Docker Desktop alias is unsafe") from error
    try:
        alias_length = len(alias.encode("utf-8", "strict"))
    except UnicodeEncodeError as error:
        raise BuildControlError("candidate Docker Desktop alias is not valid UTF-8") from error
    if (not alias.startswith(WSL_ALIAS) or "," in alias or "\\" in alias
            or alias_length > 4096):
        raise BuildControlError("candidate bind is not an exact safe WSL Desktop alias")
    return alias


def _backend_image(control, backend):
    if getattr(control, "project", None) != "fullmag-master":
        raise BuildControlError("bind overlap probe is limited to the registered master group")
    if not isinstance(backend, Mapping):
        raise BuildControlError("backend inspect record is missing")
    image = backend.get("Image")
    if not isinstance(image, str) or _IMAGE_ID.fullmatch(image) is None:
        raise BuildControlError("bind overlap probe requires the exact immutable backend image ID")
    config = backend.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if (not isinstance(labels, Mapping)
            or labels.get("com.docker.compose.project") != control.project
            or labels.get("com.docker.compose.service") != "backend"):
        raise BuildControlError("bind overlap probe backend is not the selected master backend")
    return image


def _probe_command(control, image, alias, reference_root):
    alias_mount = "type=bind,src=" + alias + ",dst=/candidate,readonly"
    reference_mount = "type=bind,src=" + str(reference_root) + ",dst=/reference,readonly"
    return [
        *docker_dev_host.docker_argv("run"), "--rm", "-i",
        "--pull", "never", "--network", "none", "--runtime", "runc",
        "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--pids-limit", "32", "--memory", "64m", "--cpus", "0.25",
        "--env", "NVIDIA_VISIBLE_DEVICES=void",
        "--label", "com.docker.compose.project=" + control.project,
        "--label", "com.docker.compose.service=host-runtime-maintenance",
        "--label", "org.fullmag.compose.project=" + control.project,
        "--mount", alias_mount, "--mount", reference_mount,
        "--user", "65532:65532", "--entrypoint", "/usr/local/bin/python3",
        image, "-B", "-c", PROBE_SOURCE,
    ]


def prove_disjoint_bind(control, backend, *, alias, reference_root,
                        reference_marker_sha256):
    """Return a read-only kernel proof that one daemon alias is disjoint.

    Every ambiguity, mount-device transition, marker drift, or malformed probe
    response raises ``BuildControlError``. No control-volume or host records
    are written, and the foreign application is never entered or executed.
    """
    if os.name == "nt" or not sys.platform.startswith("linux"):
        raise BuildControlError("bind overlap proof requires a Linux/WSL host")
    expected_marker = _sha256(reference_marker_sha256, "reference_marker_sha256")
    selected_alias = _safe_alias(alias)
    image = _backend_image(control, backend)
    return _prove_disjoint_bind_with_image(
        control, image, selected_alias, reference_root, expected_marker)


def _prove_disjoint_bind_with_image(control, image, selected_alias, reference_root,
                                    expected_marker):
    """Run the shared kernel probe after the caller qualifies its backend image."""
    root = _canonical_reference_root(reference_root)
    host_before = _host_reference_identity(root)
    if host_before["marker_sha256"] != expected_marker:
        raise BuildControlError("reference owner marker differs from its raw SHA-256 pin")
    try:
        command = _probe_command(control, image, selected_alias, root)
    except (OSError, ValueError) as error:
        raise BuildControlError("read-only bind overlap probe command is invalid") from error
    request = json.dumps({"reference_marker_sha256": expected_marker},
                         sort_keys=True, separators=(",", ":")).encode("utf-8")
    try:
        result = bounded_capture(command, data=request, timeout=50,
                                 maximum=MAX_PROBE_OUTPUT_BYTES)
    except BuildControlError:
        raise
    except (OSError, subprocess.SubprocessError) as error:
        raise BuildControlError("read-only bind overlap probe could not be observed") from error
    _canonical_reference_root(root)
    host_after = _host_reference_identity(root)
    if host_after != host_before:
        raise BuildControlError("reference changed while the kernel overlap probe ran")
    if type(result.returncode) is not int or result.returncode != 0:
        raise BuildControlError("read-only bind overlap probe failed; disjointness is unproved: "
                                + result.stderr.decode("utf-8", "replace")[-2048:])
    if not isinstance(getattr(result, "stdout", None), bytes):
        raise BuildControlError("read-only bind overlap probe stdout is not raw bytes")
    try:
        parsed = _validate_probe_result(result.stdout, expected_marker, host_before["marker_size"])
    except (ValueError, TypeError, KeyError) as error:
        raise BuildControlError("read-only bind overlap probe returned invalid evidence") from error
    return {
        "schema": PROOF_SCHEMA,
        "decision": "disjoint",
        "probe_schema": parsed["schema"],
        "candidate_alias_sha256": hashlib.sha256(selected_alias.encode("utf-8")).hexdigest(),
        "reference_root_sha256": hashlib.sha256(str(root).encode("utf-8")).hexdigest(),
        **{key: value for key, value in parsed.items() if key != "schema"},
    }


def _backend_mount(backend, destination):
    mounts = backend.get("Mounts")
    if not isinstance(mounts, list):
        raise BuildControlError("selected master backend has no complete mount inventory")
    matches = [item for item in mounts if isinstance(item, Mapping)
               and item.get("Destination") == destination]
    if len(matches) != 1:
        raise BuildControlError("selected master backend has no unique " + destination + " mount")
    return matches[0]


def _validate_master_probe_backend(control, backend):
    image = _backend_image(control, backend)
    identifier = backend.get("Id")
    if not isinstance(identifier, str) or re.fullmatch(r"[0-9a-f]{64}", identifier) is None:
        raise BuildControlError("selected master backend has no exact full container ID")
    state = _backend_mount(backend, "/state")
    if state.get("Type") != "bind" or not isinstance(state.get("Source"), str):
        raise BuildControlError("selected master backend state must be a bind mount")
    _safe_alias(state["Source"])
    control_mount = _backend_mount(backend, "/opt/fullmag/control")
    ledger_mount = _backend_mount(backend, "/host-ledger")
    if (control_mount.get("Type") != "volume"
            or control_mount.get("Name") != getattr(control, "volume", None)
            or ledger_mount.get("Type") != "volume"
            or not isinstance(ledger_mount.get("Name"), str)
            or not ledger_mount["Name"]):
        raise BuildControlError("selected master backend protected mounts must be named volumes")
    return image, identifier, control_mount["Name"], ledger_mount["Name"]


def _foreign_container_pin_snapshot(container, alias):
    if not isinstance(container, Mapping):
        raise BuildControlError("foreign bind consumer inspect record is missing")
    identifier = container.get("Id")
    image = container.get("Image")
    if (not isinstance(identifier, str) or re.fullmatch(r"[0-9a-f]{64}", identifier) is None
            or not isinstance(image, str) or _IMAGE_ID.fullmatch(image) is None):
        raise BuildControlError("foreign bind consumer has no exact full ID and immutable image")
    config = container.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    mounts = container.get("Mounts")
    if not isinstance(mounts, list) or any(not isinstance(item, Mapping) for item in mounts):
        raise BuildControlError("foreign bind consumer has no complete Mounts inventory")
    if not any(item.get("Type") == "bind" and item.get("Source") == alias for item in mounts):
        raise BuildControlError("foreign bind alias is absent from the exact container Mounts")
    host_config = container.get("HostConfig")
    # Engine's HostConfig.Mounts is tagged omitempty. Binds-based containers
    # therefore legitimately omit it; keep the explicit Binds inventory and
    # all resolved mounts, lifecycle pins and physical disjointness proof.
    if not isinstance(host_config, Mapping) or "Binds" not in host_config:
        raise BuildControlError("foreign bind consumer HostConfig is missing")
    host_mounts = host_config.get("Mounts")
    binds = host_config.get("Binds")
    if ((host_mounts is not None and (not isinstance(host_mounts, list)
                                     or any(not isinstance(item, Mapping) for item in host_mounts)))
            or (binds is not None and (not isinstance(binds, list)
                                       or any(not isinstance(item, str) for item in binds)))):
        raise BuildControlError("foreign bind consumer HostConfig mount inventory is malformed")
    state = container.get("State")
    if not isinstance(state, Mapping):
        raise BuildControlError("foreign bind consumer State is missing")
    started = state.get("StartedAt")
    status = state.get("Status")
    running = state.get("Running")
    pid = state.get("Pid")
    if (not isinstance(started, str) or not started
            or not isinstance(status, str) or not status
            or type(running) is not bool
            or type(pid) is not int or pid < 0):
        raise BuildControlError("foreign bind consumer lifecycle pin is malformed")
    snapshot = {
        "id": identifier,
        "image": image,
        "mounts": list(mounts),
        "host_mounts": host_mounts,
        "binds": binds,
        "state": {"StartedAt": started, "Status": status,
                  "Running": running, "Pid": pid},
    }
    try:
        encoded = canonical(snapshot)
    except (TypeError, ValueError) as error:
        raise BuildControlError("foreign bind consumer snapshot is not canonical JSON") from error
    return {**snapshot, "sha256": hashlib.sha256(encoded).hexdigest()}


def _foreign_container_pin(container, alias):
    """Keep the legacy master fallback's own-application exclusion unchanged."""
    if not isinstance(container, Mapping):
        raise BuildControlError("foreign bind consumer inspect record is missing")
    config = container.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if (isinstance(labels, Mapping)
            and labels.get("com.docker.compose.project") == "fullmag-master"
            and labels.get("com.docker.compose.service") in {"backend", "frontend"}):
        raise BuildControlError("selected master application container cannot use foreign-alias fallback")
    return _foreign_container_pin_snapshot(container, alias)


def _worktree_foreign_container_pin(container, alias, selected_project):
    """Pin a labelled consumer while allowing master to be foreign to a worktree."""
    if not isinstance(container, Mapping):
        raise BuildControlError("foreign bind consumer inspect record is missing")
    config = container.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    if not isinstance(labels, Mapping):
        raise BuildControlError("worktree foreign consumer has no Compose project labels")
    project = labels.get("com.docker.compose.project")
    service = labels.get("com.docker.compose.service")
    if not isinstance(project, str) or not project or not isinstance(service, str) or not service:
        raise BuildControlError("worktree foreign consumer has an incomplete Compose identity")
    org_project = labels.get("org.fullmag.compose.project")
    if project == selected_project or org_project == selected_project:
        raise BuildControlError("selected worktree project container cannot use foreign-alias fallback")
    pin = _foreign_container_pin_snapshot(container, alias)
    mount_matches = [item for item in pin["mounts"]
                     if item.get("Type") == "bind" and item.get("Source") == alias]
    if len(mount_matches) != 1:
        raise BuildControlError("worktree foreign bind alias is missing or ambiguous")
    snapshot = {key: value for key, value in pin.items() if key != "sha256"}
    snapshot.update(compose_project=project, compose_service=service,
                    org_fullmag_project=org_project,
                    source_project_id=labels.get("org.fullmag.source.project-id"),
                    source_worktree_id=labels.get("org.fullmag.source.worktree-id"))
    try:
        encoded = canonical(snapshot)
    except (TypeError, ValueError) as error:
        raise BuildControlError("worktree foreign consumer snapshot is not canonical JSON") from error
    return {**snapshot, "sha256": hashlib.sha256(encoded).hexdigest()}


def _archive_foreign_proof(control, proof):
    operation = getattr(control, "_active_operation", None)
    if operation is None:
        return
    root = operation.get("root") if isinstance(operation, Mapping) else None
    receipt = operation.get("receipt") if isinstance(operation, Mapping) else None
    if (not isinstance(root, str) or not re.fullmatch(r"[A-Za-z0-9_./-]+", root)
            or root.startswith("/") or ".." in PurePosixPath(root).parts
            or "." in PurePosixPath(root).parts or str(PurePosixPath(root)) != root
            or not isinstance(receipt, dict)):
        raise BuildControlError("active operation cannot archive foreign bind proof")
    relative = root + "/foreign-bind-proofs/" + uuid.uuid4().hex + ".json"
    raw = canonical(proof)
    references = receipt.get("foreign_bind_proofs", [])
    if (not isinstance(references, list)
            or any(not isinstance(item, dict) or set(item) != {"path", "sha256"}
                   for item in references)):
        raise BuildControlError("operation receipt has a malformed foreign proof list")
    for item in references:
        if (not isinstance(item["path"], str)
                or not item["path"].startswith(root + "/foreign-bind-proofs/")
                or re.fullmatch(re.escape(root) + r"/foreign-bind-proofs/[0-9a-f]{32}\.json",
                                item["path"]) is None
                or not isinstance(item["sha256"], str)
                or _SHA256.fullmatch(item["sha256"]) is None):
            raise BuildControlError("operation receipt has an invalid foreign proof reference")
    if len({item["path"] for item in references}) != len(references):
        raise BuildControlError("operation receipt has duplicate foreign proof references")
    try:
        existing = control.read_bytes(relative, optional=True)
    except (OSError, BuildControlError) as error:
        raise BuildControlError("foreign bind proof archive path could not be checked") from error
    if existing is not None or any(item["path"] == relative for item in references):
        raise BuildControlError("foreign bind proof archive path already exists or is referenced")
    try:
        control.write_bytes(relative, raw)
        if control.read_bytes(relative) != raw:
            raise BuildControlError("foreign bind proof archive readback differs")
        references = list(references)
        descriptor = {"path": relative, "sha256": hashlib.sha256(raw).hexdigest()}
        references.append(descriptor)
        receipt["foreign_bind_proofs"] = references
        control.write(root + "/receipt.json", receipt)
    except (OSError, BuildControlError, TypeError, ValueError) as error:
        if isinstance(error, BuildControlError):
            raise
        raise BuildControlError("foreign bind proof could not be durably archived") from error


def _validate_worktree_context_record(context, proof, container_id):
    if not isinstance(context, Mapping) or set(context) != _WORKTREE_CONTEXT_FIELDS:
        raise BuildControlError("worktree alias proof has no exact retained context")
    project = context.get("compose_project")
    if (not isinstance(project, str)
            or re.fullmatch(r"fullmag-worktree-[a-z0-9_-]+", project) is None):
        raise BuildControlError("worktree alias proof Compose identity is invalid")
    for name in ("worktree_id", "source_project_id"):
        value = context.get(name)
        if (not isinstance(value, str)
                or re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,79}", value) is None):
            raise BuildControlError("worktree alias proof identity is malformed: " + name)
    for name in ("source_root_sha256", "compose_sha256", "reference_root_sha256",
                 "certificate_sha256", "owner_marker_sha256"):
        value = context.get(name)
        if not isinstance(value, str) or _SHA256.fullmatch(value) is None or value == "0" * 64:
            raise BuildControlError("worktree alias proof digest is malformed: " + name)
    backend_id = context.get("backend_container_id")
    if (not isinstance(backend_id, str) or re.fullmatch(r"[0-9a-f]{64}", backend_id) is None
            or backend_id == container_id):
        raise BuildControlError("worktree alias proof backend identity is invalid")
    if (not isinstance(context.get("backend_image_id"), str)
            or _IMAGE_ID.fullmatch(context["backend_image_id"]) is None):
        raise BuildControlError("worktree alias proof backend image is invalid")
    try:
        from bootstrap_docker_toolchain import control_volume_name
        expected_volume = control_volume_name(project)
    except (TypeError, ValueError) as error:
        raise BuildControlError("worktree alias proof control volume is invalid") from error
    namespace = context.get("control_namespace")
    if (not isinstance(namespace, str)
            or (namespace and re.fullmatch(r"namespaces/[0-9a-f]{32}", namespace) is None)):
        raise BuildControlError("worktree alias proof control namespace is invalid")
    ledger_subpath = "/".join(part for part in (namespace, "private/ledger") if part)
    if (context.get("control_volume") != expected_volume
            or context.get("ledger_volume") != expected_volume
            or context.get("ledger_subpath") != ledger_subpath):
        raise BuildControlError("worktree alias proof ADR 0076 volume role differs")
    device, inode = context.get("reference_device"), context.get("reference_inode")
    if (type(device) is not int or device < 0 or device > 2**64 - 1
            or type(inode) is not int or inode <= 0 or inode > 2**64 - 1):
        raise BuildControlError("worktree alias proof reference inode identity is invalid")
    engine_id = context.get("engine_id")
    if (not isinstance(engine_id, str) or not engine_id or len(engine_id) > 256
            or any(ord(character) < 0x20 or ord(character) == 0x7f for character in engine_id)):
        raise BuildControlError("worktree alias proof Docker engine identity is invalid")


def validate_foreign_alias_disjoint_proof(proof, *, alias, container_id):
    """Validate either exact master or worktree evidence before skipping a bind."""
    expected_alias_sha = hashlib.sha256(_safe_alias(alias).encode("utf-8")).hexdigest()
    if not isinstance(proof, Mapping):
        raise BuildControlError("foreign alias proof does not match its typed schema")
    worktree = proof.get("schema") == WORKTREE_FOREIGN_PROOF_SCHEMA
    expected_fields = _WORKTREE_FOREIGN_PROOF_FIELDS if worktree else _FOREIGN_PROOF_FIELDS
    if set(proof) != expected_fields:
        raise BuildControlError("foreign alias proof does not match its typed schema")
    expected_schema = WORKTREE_FOREIGN_PROOF_SCHEMA if worktree else FOREIGN_PROOF_SCHEMA
    if (proof.get("schema") != expected_schema or proof.get("decision") != "disjoint"
            or proof.get("container_id") != container_id
            or not isinstance(proof.get("image_id"), str)
            or _IMAGE_ID.fullmatch(proof["image_id"]) is None
            or not isinstance(proof.get("started_at"), str) or not proof["started_at"]
            or not isinstance(proof.get("status"), str) or not proof["status"]
            or type(proof.get("running")) is not bool
            or type(proof.get("pid")) is not int or proof["pid"] < 0
            or proof.get("candidate_alias_sha256") != expected_alias_sha):
        raise BuildControlError("foreign alias proof identity or decision is invalid")
    for name in ("inspection_sha256", "reference_root_sha256"):
        if not isinstance(proof.get(name), str) or _SHA256.fullmatch(proof[name]) is None:
            raise BuildControlError("foreign alias proof digest is malformed: " + name)
    kernel = proof.get("kernel_proof")
    if not isinstance(kernel, Mapping) or set(kernel) != _KERNEL_PROOF_FIELDS:
        raise BuildControlError("foreign alias proof has no exact kernel evidence")
    if (kernel.get("schema") != PROOF_SCHEMA or kernel.get("decision") != "disjoint"
            or kernel.get("probe_schema") != PROBE_SCHEMA
            or kernel.get("candidate_alias_sha256") != expected_alias_sha
            or kernel.get("reference_root_sha256") != proof["reference_root_sha256"]):
        raise BuildControlError("foreign alias kernel evidence identity or decision is invalid")
    for name in ("reference_marker_sha256", "mountinfo_sha256"):
        if not isinstance(kernel.get(name), str) or _SHA256.fullmatch(kernel[name]) is None:
            raise BuildControlError("foreign alias kernel evidence digest is malformed: " + name)
    if worktree:
        context = proof.get("worktree_context")
        _validate_worktree_context_record(context, proof, container_id)
        if (context["reference_root_sha256"] != proof["reference_root_sha256"]
                or context["owner_marker_sha256"] != kernel["reference_marker_sha256"]
                or kernel["reference_stat"].get("device") != context["reference_device"]
                or kernel["reference_stat"].get("inode") != context["reference_inode"]):
            raise BuildControlError("worktree alias kernel and retained context evidence differ")
    return proof


def prove_foreign_alias_disjoint(control, backend, container, alias, reference_root):
    """Kernel-prove one unknown alias and pin the foreign incarnation around it."""
    image, backend_id, control_volume, ledger_volume = _validate_master_probe_backend(
        control, backend)
    selected_alias = _safe_alias(alias)
    if not isinstance(container, Mapping) or container.get("Id") == backend_id:
        raise BuildControlError("selected master backend cannot be treated as a foreign consumer")
    before = _foreign_container_pin(container, selected_alias)
    for mount in container["Mounts"]:
        if (mount.get("Type") == "volume"
                and mount.get("Name") in {control_volume, ledger_volume}):
            raise BuildControlError("foreign consumer references the selected control volume or ledger")
    for observation in range(MAX_FOREIGN_LIFECYCLE_PROOFS):
        try:
            marker = _host_reference_identity(_canonical_reference_root(reference_root))
            kernel = prove_disjoint_bind(
                control, backend, alias=selected_alias, reference_root=reference_root,
                reference_marker_sha256=marker["marker_sha256"],
            )
        except BuildControlError:
            raise
        except (OSError, TypeError, ValueError) as error:
            raise BuildControlError("foreign alias kernel proof could not be established") from error
        try:
            observed = docker_capture("inspect", before["id"], timeout=60)
            documents = json.loads(observed.stdout.decode("utf-8", "strict"),
                                   object_pairs_hook=_reject_duplicate_keys)
        except (BuildControlError, OSError, subprocess.SubprocessError, UnicodeDecodeError,
                json.JSONDecodeError, ValueError, TypeError, AttributeError) as error:
            raise BuildControlError(
                f"foreign consumer {before['id']} could not be re-inspected after the kernel proof"
            ) from error
        if not isinstance(documents, list) or len(documents) != 1:
            raise BuildControlError("fresh foreign consumer inspect is not one exact container")
        after = _foreign_container_pin(documents[0], selected_alias)
        if after == before:
            break
        changed = sorted(key for key in before if key != "sha256" and before[key] != after[key])
        if changed != ["state"]:
            raise BuildControlError(
                f"foreign consumer {before['id']} identity changed during overlap proof: {','.join(changed)}"
            )
        if observation + 1 == MAX_FOREIGN_LIFECYCLE_PROOFS:
            raise BuildControlError(
                f"foreign consumer {before['id']} lifecycle remained unstable during overlap proof"
            )
        # The inventory can precede slow Windows proofs. A sibling's ordinary
        # lifecycle transition requires a NEW physical proof, not a relabelled
        # old result. Identity/image/all mount metadata must remain exact, and
        # the new before/after lifecycle pins must agree before publication.
        before = after
    proof = {
        "schema": FOREIGN_PROOF_SCHEMA,
        "decision": "disjoint",
        "container_id": before["id"],
        "image_id": before["image"],
        "started_at": before["state"]["StartedAt"],
        "status": before["state"]["Status"],
        "running": before["state"]["Running"],
        "pid": before["state"]["Pid"],
        "inspection_sha256": before["sha256"],
        "candidate_alias_sha256": kernel["candidate_alias_sha256"],
        "reference_root_sha256": kernel["reference_root_sha256"],
        "kernel_proof": kernel,
    }
    _archive_foreign_proof(control, proof)
    return proof


def _inspect_exact_container(identifier, label):
    try:
        observed = docker_capture("inspect", identifier, timeout=60)
        documents = json.loads(observed.stdout.decode("utf-8", "strict"),
                               object_pairs_hook=_reject_duplicate_keys)
    except (BuildControlError, OSError, subprocess.SubprocessError, UnicodeDecodeError,
            json.JSONDecodeError, ValueError, TypeError, AttributeError) as error:
        raise BuildControlError(label + " could not be re-inspected") from error
    if (not isinstance(documents, list) or len(documents) != 1
            or not isinstance(documents[0], Mapping) or documents[0].get("Id") != identifier):
        raise BuildControlError(label + " inspect is not one exact container")
    return documents[0]


def _strict_stopped_backend_observation(backend):
    """Require one exact stopped incarnation and normalize unordered mounts."""
    import docker_volume_container_recovery as recovery

    try:
        recovery._strict_stopped(backend)
        return recovery._stable_container_observation(backend)
    except (BuildControlError, KeyError, TypeError, ValueError) as error:
        raise BuildControlError("selected worktree backend is not strictly stopped") from error


def _worktree_reference_pin(root, compose):
    """Pin no-follow Linux certificate bytes and their root/engine identity."""
    import docker_volume_dev as volume_dev
    import linux_native_host as host

    root = _canonical_reference_root(root)
    try:
        identity_before = _host_reference_identity(root)
        certificate_path = volume_dev._certificate_path(root)
        owner_path = root / host.OWNER_NAME
        certificate_raw_before = host.read_owned_regular(certificate_path)
        owner_raw_before = host.read_owned_regular(owner_path)
        certificate = volume_dev._retained_certificate(root, compose)
        certificate_raw_after = host.read_owned_regular(certificate_path)
        owner_raw_after = host.read_owned_regular(owner_path)
        identity_after = _host_reference_identity(root)
        certificate_document = json.loads(
            certificate_raw_after.decode("utf-8", "strict"),
            object_pairs_hook=_reject_duplicate_keys,
        )
        owner_document = json.loads(
            owner_raw_after.decode("utf-8", "strict"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except BuildControlError:
        raise
    except (OSError, RuntimeError, TypeError, ValueError, UnicodeDecodeError,
            json.JSONDecodeError) as error:
        raise BuildControlError("retained Linux certificate or owner marker is unavailable") from error
    if (identity_before != identity_after
            or certificate_raw_before != certificate_raw_after
            or owner_raw_before != owner_raw_after
            or certificate_document != certificate or owner_document != certificate
            or not isinstance(certificate, Mapping)):
        raise BuildControlError("retained Linux certificate, marker or root changed during observation")
    if (certificate.get("schema") != host.HOST_SCHEMA
            or certificate.get("storage_profile") != host.PROFILE
            or certificate.get("role") != "session"
            or certificate.get("owner_scope") != "docker-linux"
            or certificate.get("host_root") != str(root)
            or certificate.get("host_inode") != identity_after["root_inode"]
            or certificate.get("host_device") != identity_after["root_device"]
            or not isinstance(certificate.get("engine_id"), str)
            or not certificate["engine_id"]):
        raise BuildControlError("retained Linux certificate does not attest the exact root and engine")
    marker_sha = hashlib.sha256(owner_raw_after).hexdigest()
    if (marker_sha != identity_after["marker_sha256"]
            or certificate.get("host_inode") != identity_after["root_inode"]):
        raise BuildControlError("retained Linux owner marker bytes or root inode differ")
    return {
        "reference_device": identity_after["root_device"],
        "reference_inode": identity_after["root_inode"],
        "engine_id": certificate["engine_id"],
        "certificate_sha256": hashlib.sha256(certificate_raw_after).hexdigest(),
        "owner_marker_sha256": marker_sha,
    }


def _inspect_worktree_control_volume(control, backend, compose, namespace):
    import docker_group_storage as group_storage

    expected_subpath = group_storage.role_subpath(control, "control")
    if expected_subpath != namespace:
        raise BuildControlError("selected BuildControl namespace differs from its role resolver")
    descriptor = group_storage.volume_declaration(control)
    compose_volumes = compose.get("volumes")
    if not isinstance(compose_volumes, Mapping):
        raise BuildControlError("retained Compose has no control volume declarations")
    service = compose.get("services", {}).get("backend", {})
    declared = [item for item in service.get("volumes", [])
                if isinstance(item, Mapping) and item.get("target") == "/opt/fullmag/control"]
    source_alias = declared[0].get("source") if len(declared) == 1 else None
    if (len(declared) != 1 or declared[0].get("type") != "volume"
            or not isinstance(source_alias, str) or compose_volumes.get(source_alias) != descriptor
            or declared[0].get("read_only", False) is not False):
        raise BuildControlError("retained backend control mount is not the selected writable volume")
    options = declared[0].get("volume")
    if (not isinstance(options, Mapping) or options.get("nocopy") is not True
            or set(options) - {"nocopy", "subpath"}
            or options.get("subpath", "") != expected_subpath):
        raise BuildControlError("retained backend control mount namespace differs")

    mounted = _backend_mount(backend, "/opt/fullmag/control")
    if (mounted.get("Type") != "volume" or mounted.get("Name") != control.volume
            or mounted.get("RW") is not True or mounted.get("Driver") != "local"):
        raise BuildControlError("selected backend control mount differs from its stable volume")
    try:
        observed = docker_capture("volume", "inspect", control.volume, timeout=30)
        documents = json.loads(observed.stdout.decode("utf-8", "strict"),
                               object_pairs_hook=_reject_duplicate_keys)
    except (BuildControlError, OSError, subprocess.SubprocessError, UnicodeDecodeError,
            json.JSONDecodeError, ValueError, TypeError, AttributeError) as error:
        raise BuildControlError("selected BuildControl volume could not be inspected") from error
    labels = documents[0].get("Labels") if isinstance(documents, list) and len(documents) == 1 else None
    shared_labels = getattr(control, "shared_labels", None)
    if not isinstance(shared_labels, Mapping):
        labels_source = getattr(control, "labels", None)
        shared_labels = ({key: value for key, value in labels_source.items()
                          if isinstance(key, str) and key.startswith("org.fullmag.")}
                         if isinstance(labels_source, Mapping) else None)
    if (not isinstance(documents, list) or len(documents) != 1
            or not isinstance(labels, Mapping) or not isinstance(shared_labels, Mapping)
            or documents[0].get("Name") != control.volume
            or documents[0].get("Driver") != "local"
            or documents[0].get("Options") not in (None, {})
            or any(labels.get(key) != value for key, value in shared_labels.items())):
        raise BuildControlError("selected BuildControl volume ownership or driver differs")
    mountpoint = documents[0].get("Mountpoint")
    if (not isinstance(mountpoint, str) or not mountpoint.startswith("/")
            or ".." in PurePosixPath(mountpoint).parts
            or str(PurePosixPath(mountpoint)) != mountpoint):
        raise BuildControlError("selected BuildControl volume mountpoint is not canonical")
    import docker_backend_volume_cache as backend_cache
    try:
        backend_cache._validate_control_mount_subpath(
            backend, mounted, "/opt/fullmag/control", control.volume,
            expected_subpath,
            {backend_cache.CONTROL_VOLUME_ROLE: documents[0]},
        )
    except (backend_cache.BackendVolumeCacheError, KeyError, TypeError, ValueError) as error:
        raise BuildControlError("selected backend control source does not match its exact namespace") from error
    return descriptor


def _worktree_probe_context(control, backend, compose, reference_root):
    """Qualify a registered worktree backend and all retained proof inputs."""
    if os.name == "nt" or not sys.platform.startswith("linux"):
        raise BuildControlError("worktree bind overlap proof requires a Linux/WSL host")
    try:
        identity = getattr(control, "identity", None)
        if not isinstance(identity, Mapping):
            raise BuildControlError("worktree probe BuildControl has no registered identity")
        project = identity.get("project_name")
        if (identity.get("checkout_kind") != "worktree"
                or not isinstance(project, str) or project == "fullmag-master"
                or getattr(control, "project", None) != project):
            raise BuildControlError("worktree probe requires its exact registered worktree group")
        from docker_development_inputs import select_checkout
        import fullmag_storage as storage
        import docker_compose_identity
        selected = select_checkout(Path(__file__).resolve().parents[1],
                                   Path(identity.get("source_root", "")))
        selected = Path(selected).resolve(strict=True)
        derived_identity = docker_compose_identity.compose_project_identity(
            storage.resolve_layout(selected))
        if (dict(derived_identity) != dict(identity)
                or identity.get("source_root") != str(selected)):
            raise BuildControlError("BuildControl identity differs from its registered Git checkout")
        if (not isinstance(compose, Mapping) or compose.get("name") != project
                or compose.get("services", {}).get("backend") is None):
            raise BuildControlError("retained Compose name differs from the selected worktree")
        if getattr(control, "volume", None) is None:
            raise BuildControlError("worktree BuildControl volume is missing")
        import docker_group_storage as group_storage
        control_volume_descriptor = group_storage.volume_declaration(control)
        namespace = group_storage.role_subpath(control, "control")
        from docker_volume_dev import (
            _control_namespace_from_document,
            _validate_retained_service,
        )
        if _control_namespace_from_document(compose) != namespace:
            raise BuildControlError("retained Compose control namespace differs from BuildControl")
        service = compose["services"]["backend"]
        if not isinstance(service, Mapping):
            raise BuildControlError("retained Compose backend service is malformed")
        config = backend.get("Config") if isinstance(backend, Mapping) else None
        labels = config.get("Labels") if isinstance(config, Mapping) else None
        identifier = backend.get("Id") if isinstance(backend, Mapping) else None
        image_id = backend.get("Image") if isinstance(backend, Mapping) else None
        if (not isinstance(identifier, str) or re.fullmatch(r"[0-9a-f]{64}", identifier) is None
                or not isinstance(image_id, str) or _IMAGE_ID.fullmatch(image_id) is None):
            raise BuildControlError("selected worktree backend lacks its exact container and image IDs")
        if (not isinstance(labels, Mapping)
                or labels.get("com.docker.compose.project") != project
                or labels.get("com.docker.compose.service") != "backend"):
            raise BuildControlError("selected backend Compose identity differs from the worktree")
        try:
            docker_compose_identity.validate_source_labels(backend, identity)
        except (TypeError, ValueError) as error:
            raise BuildControlError("selected backend source labels differ from the registered checkout") from error
        compose_image = service.get("image")
        if not isinstance(compose_image, str) or not compose_image:
            raise BuildControlError("retained Compose backend image is missing")
        try:
            image_result = docker_capture("image", "inspect", compose_image, timeout=90)
            image_documents = json.loads(image_result.stdout.decode("utf-8", "strict"),
                                         object_pairs_hook=_reject_duplicate_keys)
        except (BuildControlError, OSError, subprocess.SubprocessError, UnicodeDecodeError,
                json.JSONDecodeError, ValueError, TypeError, AttributeError) as error:
            raise BuildControlError("retained Compose backend image could not be inspected") from error
        if (not isinstance(image_documents, list) or len(image_documents) != 1
                or image_documents[0].get("Id") != image_id
                or not isinstance(image_documents[0].get("Config"), Mapping)):
            raise BuildControlError("retained Compose backend image differs from the selected container")
        try:
            _validate_retained_service(compose, backend, "backend", image_documents[0]["Config"])
        except (BuildControlError, KeyError, TypeError, ValueError) as error:
            raise BuildControlError("selected worktree backend differs from retained Compose") from error

        root = _canonical_reference_root(reference_root)
        state_mounts = [item for item in service.get("volumes", [])
                        if isinstance(item, Mapping) and item.get("target") == "/state"]
        source_mounts = [item for item in service.get("volumes", [])
                         if isinstance(item, Mapping) and item.get("target") == "/opt/fullmag/source"]
        if (len(state_mounts) != 1 or state_mounts[0].get("type") != "bind"
                or state_mounts[0].get("source") != str(root)
                or len(source_mounts) != 1 or source_mounts[0].get("type") != "bind"
                or source_mounts[0].get("source") != str(selected)):
            raise BuildControlError("retained Compose state or source bind differs from canonical paths")
        actual_state = _backend_mount(backend, "/state")
        actual_source = _backend_mount(backend, "/opt/fullmag/source")
        daemon_binds = service.get("x-fullmag-daemon-binds")
        if (actual_state.get("Type") != "bind" or actual_state.get("RW") is not True
                or not isinstance(daemon_binds, Mapping)
                or daemon_binds.get("/state") != actual_state.get("Source")):
            raise BuildControlError("backend canonical state bind differs from its exact daemon alias")
        state_alias = _safe_alias(actual_state["Source"])
        if state_alias != daemon_binds["/state"]:
            raise BuildControlError("backend state alias differs from the retained daemon pin")
        if (actual_source.get("Type") != "bind" or actual_source.get("RW") is not False):
            raise BuildControlError("backend registered source mount is not readonly")
        from docker_linux_native_readmission import live_bind_path
        try:
            if (live_bind_path(actual_state["Source"]) != root
                    or live_bind_path(actual_source["Source"]) != selected):
                raise BuildControlError("backend state/source alias resolves to another checkout or root")
        except (OSError, RuntimeError, TypeError, ValueError) as error:
            raise BuildControlError("backend state/source alias could not be resolved") from error

        _inspect_worktree_control_volume(control, backend, compose, namespace)
        import docker_group_ledger as group_ledger
        from docker_volume_container_recovery import _ledger_snapshot_mount
        try:
            ledger_snapshot_mount, _ = _ledger_snapshot_mount(control, backend, compose)
            ledger_profile = group_ledger.retained_profile(compose, image_id)
            ledger_subpath = group_ledger._validate_expected_storage(ledger_profile)
            expected_ledger_subpath = group_storage.role_subpath(control, "ledger")
        except (BuildControlError, group_ledger.GroupLedgerError, KeyError, TypeError, ValueError) as error:
            raise BuildControlError("selected group ledger role/subpath is not authenticated") from error
        expected_snapshot = ("type=volume,src=" + control.volume
                             + ",dst=/host-ledger,readonly,volume-nocopy,volume-subpath="
                             + expected_ledger_subpath)
        actual_ledger = _backend_mount(backend, "/host-ledger")
        if (ledger_profile.get("volume_name") != control.volume
                or ledger_subpath != expected_ledger_subpath
                or not ledger_subpath.endswith("private/ledger")
                or ledger_snapshot_mount != expected_snapshot
                or actual_ledger.get("Type") != "volume"
                or actual_ledger.get("Name") != control.volume
                or actual_ledger.get("RW") is not True
                or actual_ledger.get("Driver") != "local"):
            raise BuildControlError("retained group ledger differs from ADR 0076 role storage")

        reference_pin = _worktree_reference_pin(root, compose)
        return {
            "compose_project": project,
            "worktree_id": identity["worktree_id"],
            "source_project_id": identity["project_id"],
            "source_root_sha256": hashlib.sha256(str(selected).encode("utf-8")).hexdigest(),
            "compose_sha256": hashlib.sha256(canonical(compose)).hexdigest(),
            "backend_container_id": identifier,
            "backend_image_id": image_id,
            "control_volume": control_volume_descriptor["name"],
            "control_namespace": namespace,
            "ledger_volume": ledger_profile["volume_name"],
            "ledger_subpath": ledger_subpath,
            "reference_root_sha256": hashlib.sha256(str(root).encode("utf-8")).hexdigest(),
            **reference_pin,
        }
    except BuildControlError:
        raise
    except (OSError, RuntimeError, TypeError, ValueError, KeyError, ImportError) as error:
        raise BuildControlError("registered worktree bind proof context could not be qualified") from error


def validate_worktree_foreign_alias_disjoint_proof(
    proof, *, alias, container_id, control, backend, compose, reference_root,
):
    """Rebind a worktree proof to current backend, Compose, owner and consumer evidence."""
    validate_foreign_alias_disjoint_proof(proof, alias=alias, container_id=container_id)
    if proof.get("schema") != WORKTREE_FOREIGN_PROOF_SCHEMA:
        raise BuildControlError("worktree proof validator requires the worktree proof schema")
    expected_context = proof["worktree_context"]
    backend_observation = _strict_stopped_backend_observation(backend)
    if _worktree_probe_context(control, backend, compose, reference_root) != expected_context:
        raise BuildControlError("worktree retained context changed since the foreign alias proof")
    fresh_backend = _inspect_exact_container(expected_context["backend_container_id"],
                                             "selected worktree backend")
    if _strict_stopped_backend_observation(fresh_backend) != backend_observation:
        raise BuildControlError("selected worktree backend incarnation changed since the proof")
    if _worktree_probe_context(control, fresh_backend, compose, reference_root) != expected_context:
        raise BuildControlError("selected worktree backend changed since the foreign alias proof")
    fresh_foreign = _inspect_exact_container(container_id, "worktree foreign consumer")
    current = _worktree_foreign_container_pin(fresh_foreign, _safe_alias(alias), control.project)
    if (current["sha256"] != proof["inspection_sha256"]
            or current["image"] != proof["image_id"]
            or current["state"]["StartedAt"] != proof["started_at"]
            or current["state"]["Status"] != proof["status"]
            or current["state"]["Running"] is not proof["running"]
            or current["state"]["Pid"] != proof["pid"]):
        raise BuildControlError("worktree foreign consumer incarnation changed since its proof")
    return proof


def prove_worktree_foreign_alias_disjoint(control, backend, container, alias,
                                          reference_root, *, compose):
    """Prove a foreign alias against one exact registered worktree state root."""
    selected_alias = _safe_alias(alias)
    backend_observation = _strict_stopped_backend_observation(backend)
    context = _worktree_probe_context(control, backend, compose, reference_root)
    backend_id = context["backend_container_id"]
    admission_backend = _inspect_exact_container(backend_id, "selected worktree backend")
    if _strict_stopped_backend_observation(admission_backend) != backend_observation:
        raise BuildControlError("selected worktree backend incarnation changed at proof admission")
    if _worktree_probe_context(control, admission_backend, compose, reference_root) != context:
        raise BuildControlError("selected worktree backend changed at proof admission")
    if not isinstance(container, Mapping) or container.get("Id") == backend_id:
        raise BuildControlError("selected worktree backend cannot be a foreign alias consumer")
    before = _worktree_foreign_container_pin(container, selected_alias, control.project)
    if before["id"] == backend_id:
        raise BuildControlError("selected worktree backend cannot be a foreign alias consumer")
    for mount in container["Mounts"]:
        if (mount.get("Type") == "volume"
                and mount.get("Name") in {context["control_volume"], context["ledger_volume"]}):
            raise BuildControlError("foreign consumer references the selected protected group volume")
    observed_before = _inspect_exact_container(before["id"], "worktree foreign consumer")
    fresh_before = _worktree_foreign_container_pin(observed_before, selected_alias, control.project)
    changed = sorted(key for key in before if key != "sha256" and before[key] != fresh_before[key])
    if changed and changed != ["state"]:
        raise BuildControlError("foreign consumer identity changed before overlap proof: "
                                + ",".join(changed))
    before = fresh_before

    for observation in range(MAX_FOREIGN_LIFECYCLE_PROOFS):
        try:
            kernel = _prove_disjoint_bind_with_image(
                control, context["backend_image_id"], selected_alias, reference_root,
                context["owner_marker_sha256"],
            )
        except BuildControlError:
            raise
        except (OSError, TypeError, ValueError) as error:
            raise BuildControlError("worktree foreign alias kernel proof could not be established") from error
        observed_after = _inspect_exact_container(before["id"], "worktree foreign consumer")
        after = _worktree_foreign_container_pin(observed_after, selected_alias, control.project)
        if after == before:
            break
        changed = sorted(key for key in before if key != "sha256" and before[key] != after[key])
        if changed != ["state"]:
            raise BuildControlError("foreign consumer identity changed during overlap proof: "
                                    + ",".join(changed))
        if observation + 1 == MAX_FOREIGN_LIFECYCLE_PROOFS:
            raise BuildControlError("foreign consumer lifecycle remained unstable during overlap proof")
        before = after

    fresh_backend = _inspect_exact_container(backend_id, "selected worktree backend")
    if _strict_stopped_backend_observation(fresh_backend) != backend_observation:
        raise BuildControlError("selected worktree backend lifecycle changed during proof")
    if _worktree_probe_context(control, fresh_backend, compose, reference_root) != context:
        raise BuildControlError("selected worktree source, mounts, certificate or Compose changed during proof")
    proof = {
        "schema": WORKTREE_FOREIGN_PROOF_SCHEMA,
        "decision": "disjoint",
        "container_id": before["id"],
        "image_id": before["image"],
        "started_at": before["state"]["StartedAt"],
        "status": before["state"]["Status"],
        "running": before["state"]["Running"],
        "pid": before["state"]["Pid"],
        "inspection_sha256": before["sha256"],
        "candidate_alias_sha256": kernel["candidate_alias_sha256"],
        "reference_root_sha256": kernel["reference_root_sha256"],
        "kernel_proof": kernel,
        "worktree_context": context,
    }
    validate_foreign_alias_disjoint_proof(
        proof, alias=selected_alias, container_id=before["id"])
    _archive_foreign_proof(control, proof)
    return proof
