"""Serialized, read-only Linux observer for Windows-backed Docker binds."""
from __future__ import annotations

import hashlib
import inspect
import json
import os
import re
import stat
import unicodedata


PROBE_SCHEMA = "fullmag.docker-windows-bind-probe.v1"
OWNER_MARKER = ".fullmag-linux-native-owner.json"
MAX_REQUEST_BYTES = 256 * 1024
MAX_PROC_SMALL_BYTES = 256 * 1024
MAX_MOUNTINFO_BYTES = 4 * 1024 * 1024
MAX_MOUNTINFO_RECORDS = 8192
MAX_NESTED_MOUNTS = 16
MAX_MARKER_BYTES = 1024 * 1024
MAX_VPD_BYTES = 4096
MAX_OUTPUT_BYTES = 4 * 1024 * 1024

_REQUEST_FIELDS = frozenset({
    "container_id", "pid", "uid", "gid", "destination", "reference_device",
    "reference_inode", "reference_marker_sha256", "nested_mounts",
})
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_DEVICE = re.compile(r"(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_HEX = re.compile(r"[0-9a-f]*\Z")
_CONTAINER_ID = re.compile(r"[0-9a-f]{64}\Z")
_MOUNTINFO_ESCAPES = {b"040": 0x20, b"011": 0x09, b"012": 0x0A, b"134": 0x5C}
_MOUNT_OPTION = re.compile(r"[A-Za-z0-9_+=:,.+\-]+\Z")
_FILESYSTEM = re.compile(r"[A-Za-z0-9_.+\-]+\Z")
_VOLUME_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_NAMESPACE = {
    "mnt": re.compile(r"mnt:\[[1-9][0-9]{0,19}\]\Z"),
    "user": re.compile(r"user:\[[1-9][0-9]{0,19}\]\Z"),
}
_MOUNT_ROW_FIELDS = frozenset({
    "mount_id", "parent_id", "device", "root", "mountpoint", "options",
    "fstype", "source", "super_options",
})


def _strict_integer(value, label, minimum=0, maximum=(1 << 64) - 1):
    if type(value) is not int or value < minimum or value > maximum:
        raise ValueError(label + " must be a bounded strict integer")
    return value


def _destination_components(value):
    if not isinstance(value, str) or not value or len(value.encode("utf-8", "strict")) > 4096:
        raise ValueError("destination is missing or overlong")
    if (not value.startswith("/") or value == "/" or value.startswith("//")
            or value.endswith("/") or "//" in value or "\\" in value):
        raise ValueError("destination must be a normalized non-root POSIX path")
    if any(unicodedata.category(char) in {"Cc", "Cf", "Cs", "Zl", "Zp"} for char in value):
        raise ValueError("destination contains a control character or surrogate")
    parts = value[1:].split("/")
    if (not parts or len(parts) > 128 or any(part in {"", ".", ".."} for part in parts)
            or any(len(part.encode("utf-8")) > 255 for part in parts)):
        raise ValueError("destination contains an empty, relative, or overlong component")
    return parts


def _validate_nested_mounts(value, parent_destination):
    if type(value) is not list or len(value) > MAX_NESTED_MOUNTS:
        raise ValueError("nested_mounts must be a bounded list of at most 16 volumes")
    parent_prefix = parent_destination + "/"
    fields = {"type", "destination", "source", "name", "rw", "probe_path"}
    result = []
    previous_destination = None
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != fields:
            raise ValueError("nested volume fields do not match the exact schema")
        if type(item["type"]) is not str or item["type"] != "volume":
            raise ValueError("only named Docker volumes may be nested under the destination")
        destination = item["destination"]
        _safe_mount_path(destination)
        _destination_components(destination)
        if not destination.startswith(parent_prefix):
            raise ValueError("nested volume destination is not a descendant of the main destination")
        if previous_destination is not None and destination <= previous_destination:
            raise ValueError("nested volume destinations must be uniquely sorted")
        previous_destination = destination
        source = item["source"]
        _safe_mount_path(source)
        if source == "/":
            raise ValueError("nested Docker volume source cannot be the filesystem root")
        name = item["name"]
        if type(name) is not str or _VOLUME_NAME.fullmatch(name) is None:
            raise ValueError("nested Docker volume name is malformed")
        if type(item["rw"]) is not bool:
            raise ValueError("nested volume rw must be a strict boolean")
        probe_path = "/nested-" + str(index)
        if type(item["probe_path"]) is not str or item["probe_path"] != probe_path:
            raise ValueError("nested volume probe paths must follow sorted list order")
        result.append({
            "type": "volume", "destination": destination, "source": source,
            "name": name, "rw": item["rw"], "probe_path": probe_path,
        })
    return result


def _validate_request(value):
    if not isinstance(value, dict) or set(value) != _REQUEST_FIELDS:
        raise ValueError("probe request fields do not match the exact schema")
    container_id = value["container_id"]
    if not isinstance(container_id, str) or _CONTAINER_ID.fullmatch(container_id) is None:
        raise ValueError("container_id must be a full lowercase 64-hex Docker ID")
    result = {
        "container_id": container_id,
        "pid": _strict_integer(value["pid"], "pid", 1, (1 << 31) - 1),
        "uid": _strict_integer(value["uid"], "uid", 0, (1 << 32) - 1),
        "gid": _strict_integer(value["gid"], "gid", 0, (1 << 32) - 1),
        "destination": value["destination"],
        "reference_device": _strict_integer(value["reference_device"], "reference_device"),
        "reference_inode": _strict_integer(value["reference_inode"], "reference_inode", 1),
        "reference_marker_sha256": value["reference_marker_sha256"],
    }
    _destination_components(result["destination"])
    if (not isinstance(result["reference_marker_sha256"], str)
            or _HEX64.fullmatch(result["reference_marker_sha256"]) is None):
        raise ValueError("reference_marker_sha256 must be a lowercase SHA-256")
    result["nested_mounts"] = _validate_nested_mounts(value["nested_mounts"], result["destination"])
    return result


def _parse_pid_stat(raw, expected_pid):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_PROC_SMALL_BYTES or b"\x00" in raw:
        raise ValueError("proc stat is empty, malformed, or over budget")
    line = raw[:-1] if raw.endswith(b"\n") else raw
    if b"\n" in line or b"\r" in line:
        raise ValueError("proc stat contains an unexpected line break")
    first_space = line.find(b" ")
    close_paren = line.rfind(b")")
    if first_space <= 0 or close_paren <= first_space + 2 or line[first_space + 1:first_space + 2] != b"(":
        raise ValueError("proc stat has a malformed pid/comm prefix")
    pid_raw = line[:first_space]
    if _DECIMAL.fullmatch(pid_raw.decode("ascii", "strict")) is None:
        raise ValueError("proc stat pid is malformed")
    pid = int(pid_raw)
    comm = line[first_space + 2:close_paren]
    if not comm or any(byte < 0x20 or byte == 0x7F for byte in comm):
        raise ValueError("proc stat comm is empty or contains controls")
    tail = line[close_paren + 1:]
    if not tail.startswith(b" "):
        raise ValueError("proc stat is missing its state separator")
    fields = tail[1:].split()
    if len(fields) < 20 or len(fields[0]) != 1 or fields[0] not in b"RSDZTtXxKWPI":
        raise ValueError("proc stat fields are incomplete")
    start_raw = fields[19].decode("ascii", "strict")
    if _DECIMAL.fullmatch(start_raw) is None or int(start_raw) <= 0:
        raise ValueError("proc stat start time is malformed")
    if pid != expected_pid:
        raise ValueError("proc stat pid differs from the requested process")
    return {"pid": pid, "start_ticks": start_raw}


def _parse_process_status(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_PROC_SMALL_BYTES or b"\x00" in raw:
        raise ValueError("proc status is empty, malformed, or over budget")
    try:
        lines = raw.decode("ascii", "strict").splitlines()
    except UnicodeDecodeError as error:
        raise ValueError("proc status is not ASCII") from error
    wanted = {"Uid", "Gid", "CapPrm", "CapEff"}
    values = {}
    for line in lines:
        if any((ord(char) < 0x20 and char != "\t") or ord(char) == 0x7F for char in line):
            raise ValueError("proc status contains controls")
        key, separator, value = line.partition(":")
        if key not in wanted:
            continue
        if not separator or key in values:
            raise ValueError("proc status has a malformed or duplicate identity field")
        values[key] = value.strip().split()
    if set(values) != wanted:
        raise ValueError("proc status is missing uid/gid/capability fields")
    result = {}
    for key in ("Uid", "Gid"):
        fields = values[key]
        if len(fields) != 4 or any(_DECIMAL.fullmatch(item) is None for item in fields):
            raise ValueError("proc status uid/gid must have four decimal fields")
        numbers = [int(item) for item in fields]
        if any(number > (1 << 32) - 1 for number in numbers):
            raise ValueError("proc status uid/gid is out of range")
        result["uid" if key == "Uid" else "gid"] = numbers
    for key in ("CapPrm", "CapEff"):
        fields = values[key]
        if len(fields) != 1 or re.fullmatch(r"[0-9a-fA-F]{16}", fields[0]) is None:
            raise ValueError("proc status capability mask is malformed")
        result["cap_prm" if key == "CapPrm" else "cap_eff"] = fields[0].lower()
    return result


def _parse_cgroup(raw, container_id):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_PROC_SMALL_BYTES or not raw.endswith(b"\n"):
        raise ValueError("proc cgroup is empty, malformed, or over budget")
    try:
        lines = raw[:-1].decode("ascii", "strict").split("\n")
    except UnicodeDecodeError as error:
        raise ValueError("proc cgroup is not ASCII") from error
    unified = []
    if len(lines) > 1024 or any(not line for line in lines):
        raise ValueError("proc cgroup has an invalid record count")
    for line in lines:
        if any(ord(char) < 0x20 or ord(char) == 0x7F for char in line):
            raise ValueError("proc cgroup contains controls")
        parts = line.split(":")
        if len(parts) != 3 or _DECIMAL.fullmatch(parts[0]) is None or not parts[2].startswith("/"):
            raise ValueError("proc cgroup record is malformed")
        path_parts = parts[2][1:].split("/")
        if any(part in {"", ".", ".."} for part in path_parts):
            if parts[2] != "/" and parts[2] != "/../" + container_id:
                raise ValueError("proc cgroup path is ambiguous")
        if parts[0] == "0" and parts[1] == "":
            unified.append((line, path_parts))
    if len(unified) != 1:
        raise ValueError("proc cgroup has no unique unified v2 record")
    line, components = unified[0]
    if components.count(container_id) != 1:
        raise ValueError("proc cgroup does not name the full container ID component")
    return lines


def _parse_namespace(value, kind):
    if (not isinstance(value, str) or len(value) > 64
            or _NAMESPACE[kind].fullmatch(value) is None):
        raise ValueError("proc namespace identity is malformed")
    return value


def _decode_mountinfo_path(raw):
    if not isinstance(raw, bytes):
        raise ValueError("mountinfo path field is not bytes")
    result = bytearray()
    index = 0
    while index < len(raw):
        if raw[index] != 0x5C:
            result.append(raw[index])
            index += 1
            continue
        escape = raw[index + 1:index + 4]
        if len(escape) != 3 or escape not in _MOUNTINFO_ESCAPES:
            raise ValueError("mountinfo path contains an unknown escape")
        result.append(_MOUNTINFO_ESCAPES[escape])
        index += 4
    try:
        return result.decode("utf-8", "strict")
    except UnicodeDecodeError as error:
        raise ValueError("mountinfo path is not UTF-8") from error


def _safe_mount_path(value):
    if (not isinstance(value, str) or not value.startswith("/") or value.startswith("//")
            or len(value.encode("utf-8", "strict")) > 4096
            or any(unicodedata.category(char) in {"Cc", "Cf", "Cs", "Zl", "Zp"} for char in value)
            or any(part in {".", ".."} for part in value.split("/"))):
        raise ValueError("mountinfo contains an unsafe path")
    if value != "/" and (value.endswith("/") or "//" in value):
        raise ValueError("mountinfo path is not normalized")
    return value


def _parse_mountinfo(raw):
    if (not isinstance(raw, bytes) or not raw or len(raw) > MAX_MOUNTINFO_BYTES
            or not raw.endswith(b"\n") or b"\r" in raw or b"\x00" in raw):
        raise ValueError("mountinfo is empty, malformed, or over budget")
    lines = raw[:-1].split(b"\n")
    if len(lines) > MAX_MOUNTINFO_RECORDS:
        raise ValueError("mountinfo record count exceeds its budget")
    rows = []
    seen_ids = set()
    for line in lines:
        if not line or len(line) > 16 * 1024 or any(byte < 0x20 or byte == 0x7F for byte in line):
            raise ValueError("mountinfo row is empty, overlong, or contains controls")
        fields = line.split(b" ")
        if len(fields) < 10 or any(not field for field in fields):
            raise ValueError("mountinfo row fields are malformed")
        separators = [index for index, field in enumerate(fields[6:], 6) if field == b"-"]
        if len(separators) != 1:
            raise ValueError("mountinfo row has no unique filesystem separator")
        separator = separators[0]
        if separator < 6 or len(fields) != separator + 4:
            raise ValueError("mountinfo filesystem fields are malformed")
        try:
            mount_id_text = fields[0].decode("ascii", "strict")
            parent_id_text = fields[1].decode("ascii", "strict")
            device_text = fields[2].decode("ascii", "strict")
            options = fields[5].decode("ascii", "strict")
            fstype = fields[separator + 1].decode("ascii", "strict")
            super_options = fields[separator + 3].decode("ascii", "strict")
        except UnicodeDecodeError as error:
            raise ValueError("mountinfo numeric/options fields are not ASCII") from error
        if (_DECIMAL.fullmatch(mount_id_text) is None
                or _DECIMAL.fullmatch(parent_id_text) is None
                or _DEVICE.fullmatch(device_text) is None):
            raise ValueError("mountinfo identifiers or device are malformed")
        mount_id, parent_id = int(mount_id_text), int(parent_id_text)
        if (mount_id < 1 or mount_id > (1 << 63) - 1 or parent_id > (1 << 63) - 1
                or mount_id in seen_ids):
            raise ValueError("mountinfo IDs are unsafe or duplicated")
        seen_ids.add(mount_id)
        major_text, minor_text = device_text.split(":")
        if int(major_text) > (1 << 32) - 1 or int(minor_text) > (1 << 32) - 1:
            raise ValueError("mountinfo device is out of range")
        if (not options or _MOUNT_OPTION.fullmatch(options) is None
                or not super_options or any(ord(char) < 33 or ord(char) > 126 for char in super_options)
                or not fstype or _FILESYSTEM.fullmatch(fstype) is None):
            raise ValueError("mountinfo filesystem options are malformed")
        root = _safe_mount_path(_decode_mountinfo_path(fields[3]))
        mountpoint = _safe_mount_path(_decode_mountinfo_path(fields[4]))
        source = _decode_mountinfo_path(fields[separator + 2])
        if (not source or len(source.encode("utf-8")) > 4096
                or any(unicodedata.category(char) in {"Cc", "Cf", "Cs", "Zl", "Zp"} for char in source)):
            raise ValueError("mountinfo source is malformed")
        for optional in fields[6:separator]:
            if re.fullmatch(rb"[A-Za-z0-9_:+.-]+", optional) is None:
                raise ValueError("mountinfo optional field is malformed")
        rows.append({
            "mount_id": mount_id,
            "parent_id": parent_id,
            "device": device_text,
            "root": root,
            "mountpoint": mountpoint,
            "options": options,
            "fstype": fstype,
            "source": source,
            "super_options": super_options,
        })
    return rows


def _exact_mount_row(rows, mountpoint):
    matches = [row for row in rows if row["mountpoint"] == mountpoint]
    if len(matches) != 1:
        raise ValueError("mountinfo has no unique exact row for " + mountpoint)
    return matches[0]


def _mount_roots_overlap(left, right):
    left = left.rstrip("/") or "/"
    right = right.rstrip("/") or "/"
    return (left == right or left == "/" or right == "/"
            or left.startswith(right + "/") or right.startswith(left + "/"))


def _same_path_identity(left, right):
    return all(left[key] == right[key] for key in ("device", "inode", "type"))


def _select_mount_rows(helper_rows, target_rows, destination, nested_mounts=()):
    helper = {name: _exact_mount_row(helper_rows, path) for name, path in (
        ("candidate", "/candidate"), ("reference", "/reference"),
        ("control", "/control"), ("ledger", "/ledger"),
    )}
    target = _exact_mount_row(target_rows, destination)
    helper_candidate_nested = [row for row in helper_rows
                               if row["mountpoint"].startswith("/candidate/")]
    helper_reference_nested = [row for row in helper_rows
                               if row["mountpoint"].startswith("/reference/")]
    target_nested = [row for row in target_rows
                     if row["mountpoint"].startswith(destination.rstrip("/") + "/")]
    target_nested.sort(key=lambda row: row["mountpoint"])
    expected_destinations = [item["destination"] for item in nested_mounts]
    if [row["mountpoint"] for row in target_nested] != expected_destinations:
        raise ValueError("target nested mount set does not exactly match the request")
    if helper_candidate_nested or helper_reference_nested:
        raise ValueError("nested mounts under candidate/reference are not permitted")
    helper_nested = {}
    expected_probe_paths = {item["probe_path"] for item in nested_mounts}
    for item in nested_mounts:
        probe_path = item["probe_path"]
        row = _exact_mount_row(helper_rows, probe_path)
        if any(mount["mountpoint"].startswith(probe_path + "/") for mount in helper_rows):
            raise ValueError("nested mounts under a nested volume probe path are not permitted")
        helper_modes = [option for option in row["options"].split(",") if option in {"ro", "rw"}]
        if helper_modes != ["ro"]:
            raise ValueError("nested helper volume mount is not read-only")
        helper_nested[probe_path] = row
    unexpected_probe_rows = [
        row for row in helper_rows
        if row["mountpoint"].startswith("/nested-")
        and row["mountpoint"] not in expected_probe_paths
    ]
    if unexpected_probe_rows:
        raise ValueError("helper has an unrequested nested volume probe mount")
    for name, row in helper.items():
        helper_modes = [option for option in row["options"].split(",") if option in {"ro", "rw"}]
        if helper_modes != ["ro"]:
            raise ValueError("helper protected mount is not read-only: " + name)
    candidate = helper["candidate"]
    if candidate["device"] != target["device"] or candidate["root"] != target["root"]:
        raise ValueError("helper candidate and target destination mount rows differ")
    if candidate["fstype"] != "9p" or target["fstype"] != "9p":
        raise ValueError("candidate and target source are not exact 9p Windows bind mounts")
    target_modes = [option for option in target["options"].split(",") if option in {"ro", "rw"}]
    if len(target_modes) != 1:
        raise ValueError("target destination must have exactly one ro/rw mount option")
    for item, row in zip(nested_mounts, target_nested):
        if row["mountpoint"] != item["destination"]:
            raise ValueError("target nested mount row order differs from the request")
        target_modes = [option for option in row["options"].split(",") if option in {"ro", "rw"}]
        if len(target_modes) != 1 or target_modes[0] != ("rw" if item["rw"] else "ro"):
            raise ValueError("target nested mount mode differs from the request")
    return {
        "helper_candidate": candidate,
        "helper_reference": helper["reference"],
        "helper_control": helper["control"],
        "helper_ledger": helper["ledger"],
        "target_destination": target,
        "helper_candidate_nested": helper_candidate_nested,
        "helper_reference_nested": helper_reference_nested,
        "target_destination_nested": target_nested,
        "helper_nested_mounts": helper_nested,
    }


def _validate_vpd83(raw):
    if not isinstance(raw, bytes) or len(raw) < 5 or len(raw) > MAX_VPD_BYTES:
        raise ValueError("VPD page 0x83 is empty, truncated, or over budget")
    if raw[1] != 0x83 or int.from_bytes(raw[2:4], "big") != len(raw) - 4:
        raise ValueError("VPD page 0x83 header or declared length is malformed")
    offset = 4
    descriptors = 0
    while offset < len(raw):
        if len(raw) - offset < 4:
            raise ValueError("VPD page 0x83 has a truncated descriptor header")
        size = int.from_bytes(raw[offset + 2:offset + 4], "big")
        if size <= 0 or offset + 4 + size > len(raw):
            raise ValueError("VPD page 0x83 has an invalid descriptor size")
        offset += 4 + size
        descriptors += 1
    if offset != len(raw) or descriptors == 0:
        raise ValueError("VPD page 0x83 has no complete designator")
    return raw


def _stat_record(value):
    values = {
        "device": value.st_dev,
        "inode": value.st_ino,
        "nlink": value.st_nlink,
        "size": value.st_size,
        "mode": value.st_mode,
        "mtime_ns": value.st_mtime_ns,
        "ctime_ns": value.st_ctime_ns,
        "uid": value.st_uid,
        "gid": value.st_gid,
    }
    if any(type(item) is not int for item in values.values()):
        raise ValueError("filesystem stat has a non-integer field")
    if (values["device"] < 0 or values["device"] > (1 << 64) - 1
            or values["inode"] < 1 or values["inode"] > (1 << 64) - 1
            or values["nlink"] < 1 or values["nlink"] > (1 << 63) - 1
            or values["size"] < 0 or values["size"] > (1 << 63) - 1
            or values["mode"] < 0 or values["mode"] > (1 << 32) - 1
            or values["mtime_ns"] < -(1 << 63) or values["mtime_ns"] > (1 << 63) - 1
            or values["ctime_ns"] < -(1 << 63) or values["ctime_ns"] > (1 << 63) - 1
            or values["uid"] < 0 or values["uid"] > (1 << 32) - 1
            or values["gid"] < 0 or values["gid"] > (1 << 32) - 1):
        raise ValueError("filesystem stat field is out of range")
    if stat.S_ISDIR(values["mode"]):
        kind = "directory"
    elif stat.S_ISREG(values["mode"]):
        kind = "regular-file"
        if values["nlink"] != 1:
            raise ValueError("backing file has multiple hard links")
    else:
        raise ValueError("protected path is neither a directory nor a regular file")
    return {**values, "type": kind}


def _read_fd(fd, limit, label):
    content = bytearray()
    while True:
        chunk = os.read(fd, min(65536, limit + 1 - len(content)))
        if not chunk:
            break
        content.extend(chunk)
        if len(content) > limit:
            raise ValueError(label + " exceeds its byte budget")
    return bytes(content)


def _close_fds(fds):
    errors = []
    for fd in reversed(fds):
        try:
            os.close(fd)
        except OSError as error:
            errors.append(error)
    if errors:
        raise OSError("could not close every metadata-only observer descriptor") from errors[0]


def _read_path(path, limit):
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("proc entry is not a regular pseudo-file")
        return _read_fd(fd, limit, "proc entry")
    finally:
        os.close(fd)


def _readlink(path, kind):
    try:
        return _parse_namespace(os.readlink(path), kind)
    except OSError as error:
        raise ValueError("cannot read authenticated process namespace") from error


def _process_snapshot(request):
    base = "/proc/" + str(request["pid"])
    stat_before = _parse_pid_stat(_read_path(base + "/stat", MAX_PROC_SMALL_BYTES), request["pid"])
    status = _parse_process_status(_read_path(base + "/status", MAX_PROC_SMALL_BYTES))
    cgroup_raw = _read_path(base + "/cgroup", MAX_PROC_SMALL_BYTES)
    cgroup_lines = _parse_cgroup(cgroup_raw, request["container_id"])
    mnt_namespace = _readlink(base + "/ns/mnt", "mnt")
    user_namespace = _readlink(base + "/ns/user", "user")
    observer_user_namespace = _readlink("/proc/self/ns/user", "user")
    mountinfo = _read_path(base + "/mountinfo", MAX_MOUNTINFO_BYTES)
    _parse_mountinfo(mountinfo)
    stat_after = _parse_pid_stat(_read_path(base + "/stat", MAX_PROC_SMALL_BYTES), request["pid"])
    if stat_before != stat_after:
        raise ValueError("process identity changed while reading proc metadata")
    return {
        "start_ticks": stat_before["start_ticks"],
        "status_uid": status["uid"],
        "status_gid": status["gid"],
        "cap_prm": status["cap_prm"],
        "cap_eff": status["cap_eff"],
        "cgroup_lines": cgroup_lines,
        "mnt_namespace": mnt_namespace,
        "user_namespace": user_namespace,
        "observer_user_namespace": observer_user_namespace,
        "mountinfo": mountinfo,
    }


def _assert_process_identity(snapshot, request):
    if any(uid != request["uid"] for uid in snapshot["status_uid"]):
        raise ValueError("target process UID fields differ from Config.User")
    if any(gid != request["gid"] for gid in snapshot["status_gid"]):
        raise ValueError("target process GID fields differ from Config.User")
    if snapshot["cap_prm"] != "0000000000000000" or snapshot["cap_eff"] != "0000000000000000":
        raise ValueError("target process has permitted or effective capabilities")
    if snapshot["user_namespace"] != snapshot["observer_user_namespace"]:
        raise ValueError("target and observer use different user namespaces")


def _same_process_snapshot(before, after):
    fields = (
        "start_ticks", "status_uid", "status_gid", "cap_prm", "cap_eff", "cgroup_lines",
        "mnt_namespace", "user_namespace", "observer_user_namespace", "mountinfo",
    )
    return all(before[field] == after[field] for field in fields)


def _stat_cookie(value):
    record = _stat_record(value)
    if record["type"] != "directory":
        raise ValueError("process root is not a directory")
    return {key: record[key] for key in ("device", "inode", "mode")}


def _fresh_proc_root_cookie(pid):
    fd = os.open("/proc/" + str(pid) + "/root", os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        return _stat_cookie(os.fstat(fd))
    finally:
        os.close(fd)


def _open_path_at_root(root_fd, destination):
    components = _destination_components(destination)
    flags = os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC
    opened = [os.open(".", flags, dir_fd=root_fd)]
    try:
        for index, component in enumerate(components):
            child_flags = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC
            if index < len(components) - 1:
                child_flags |= os.O_DIRECTORY
            child_fd = os.open(component, child_flags, dir_fd=opened[-1])
            opened.append(child_fd)
            metadata = os.fstat(child_fd)
            if stat.S_ISLNK(metadata.st_mode):
                raise ValueError("destination traverses a symlink")
            if index < len(components) - 1 and not stat.S_ISDIR(metadata.st_mode):
                raise ValueError("destination has a non-directory ancestor")
        _stat_record(os.fstat(opened[-1]))
        return opened
    except BaseException:
        _close_fds(opened)
        raise


def _open_helper_path(path, directory):
    flags = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC
    if directory:
        flags |= os.O_DIRECTORY
    fd = os.open(path, flags)
    try:
        record = _stat_record(os.fstat(fd))
        if stat.S_ISLNK(record["mode"]):
            raise ValueError("protected helper path is a symlink")
        if directory and record["type"] != "directory":
            raise ValueError("protected helper path is not a directory")
        return fd, record
    except BaseException:
        os.close(fd)
        raise


def _read_reference_marker(root_fd, expected_sha256):
    fd = os.open(OWNER_MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root_fd)
    try:
        before = _stat_record(os.fstat(fd))
        if before["type"] != "regular-file" or before["size"] <= 0 or before["size"] > MAX_MARKER_BYTES:
            raise ValueError("reference owner marker is not a bounded regular file")
        raw = _read_fd(fd, MAX_MARKER_BYTES, "reference owner marker")
        after = _stat_record(os.fstat(fd))
        path_after = _stat_record(os.stat(OWNER_MARKER, dir_fd=root_fd, follow_symlinks=False))
        if before != after or before != path_after or len(raw) != before["size"]:
            raise ValueError("reference owner marker changed while being read")
        digest = hashlib.sha256(raw).hexdigest()
        if digest != expected_sha256:
            raise ValueError("reference owner marker digest differs from the request")
        if before["device"] != _stat_record(os.fstat(root_fd))["device"]:
            raise ValueError("reference owner marker is on a nested filesystem")
        return {"sha256": digest, "size": len(raw), "stat": before}
    finally:
        os.close(fd)


def _device_text(device):
    major = os.major(device)
    minor = os.minor(device)
    if type(major) is not int or type(minor) is not int or major <= 0 or major > (1 << 32) - 1:
        raise ValueError("protected path is not backed by a supported block device")
    if major == 7:
        raise ValueError("loop devices are not accepted as protected storage")
    if minor < 0 or minor > (1 << 32) - 1:
        raise ValueError("protected block device minor is out of range")
    return major, minor, str(major) + ":" + str(minor)


def _read_vpd(device):
    major, minor, text = _device_text(device)
    block_path = "/sys/dev/block/" + text
    device_path = block_path + "/device/vpd_pg83"
    fd = os.open(device_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("VPD page is not a regular sysfs attribute")
        raw = _read_fd(fd, MAX_VPD_BYTES, "VPD page 0x83")
    finally:
        os.close(fd)
    _validate_vpd83(raw)
    return {"major": major, "minor": minor, "vpd83_hex": raw.hex()}


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON contains a duplicate key")
        result[key] = value
    return result


def _json_constant(value):
    raise ValueError("JSON contains a non-finite number")


def _observe(request):
    if os.getuid() != request["uid"] or os.getgid() != request["gid"]:
        raise ValueError("observer UID/GID differ from the requested numeric identity")
    if not all(hasattr(os, name) for name in ("O_PATH", "O_NOFOLLOW", "O_CLOEXEC")):
        raise ValueError("Linux O_PATH and no-follow flags are required")

    process_before = _process_snapshot(request)
    _assert_process_identity(process_before, request)
    root_path = "/proc/" + str(request["pid"]) + "/root"
    root_fd = os.open(root_path, os.O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
    owned_fds = [root_fd]
    try:
        root_cookie_before = _stat_cookie(os.fstat(root_fd))
        if _fresh_proc_root_cookie(request["pid"]) != root_cookie_before:
            raise ValueError("proc root changed while it was being pinned")
        process_opened = _process_snapshot(request)
        _assert_process_identity(process_opened, request)
        if not _same_process_snapshot(process_before, process_opened):
            raise ValueError("process identity changed while authenticating proc root")

        helper_before = _read_path("/proc/self/mountinfo", MAX_MOUNTINFO_BYTES)
        helper_rows = _parse_mountinfo(helper_before)
        target_rows = _parse_mountinfo(process_opened["mountinfo"])
        selected = _select_mount_rows(helper_rows, target_rows, request["destination"],
                                      request["nested_mounts"])

        candidate_fd, candidate_open = _open_helper_path("/candidate", False)
        owned_fds.append(candidate_fd)
        reference_fd, reference_open = _open_helper_path("/reference", True)
        owned_fds.append(reference_fd)
        control_fd, control_open = _open_helper_path("/control", True)
        owned_fds.append(control_fd)
        ledger_fd, ledger_open = _open_helper_path("/ledger", True)
        owned_fds.append(ledger_fd)

        candidate_before = _stat_record(os.fstat(candidate_fd))
        reference_root_before = _stat_cookie(os.fstat(reference_fd))
        control_before = _stat_record(os.fstat(control_fd))
        ledger_before = _stat_record(os.fstat(ledger_fd))
        if (candidate_before != candidate_open or reference_root_before != {
                "device": reference_open["device"], "inode": reference_open["inode"],
                "mode": reference_open["mode"]}):
            raise ValueError("protected mount identity changed during open")
        if control_before != control_open or ledger_before != ledger_open:
            raise ValueError("protected control/ledger mount identity changed during open")

        actual_fds_before = _open_path_at_root(root_fd, request["destination"])
        owned_fds.extend(actual_fds_before)
        actual_before = _stat_record(os.fstat(actual_fds_before[-1]))
        nested_initial = []
        target_nested_by_destination = {
            row["mountpoint"]: row for row in selected["target_destination_nested"]
        }
        for item in request["nested_mounts"]:
            actual_fds = _open_path_at_root(root_fd, item["destination"])
            owned_fds.extend(actual_fds)
            actual_stat = _stat_record(os.fstat(actual_fds[-1]))
            if actual_stat["type"] != "directory":
                raise ValueError("nested target volume destination is not a directory")
            fresh_fd, fresh_stat = _open_helper_path(item["probe_path"], True)
            owned_fds.append(fresh_fd)
            if fresh_stat["type"] != "directory":
                raise ValueError("nested helper volume source is not a directory")
            actual_mount = target_nested_by_destination[item["destination"]]
            fresh_mount = selected["helper_nested_mounts"][item["probe_path"]]
            if (actual_mount["device"] != fresh_mount["device"]
                    or actual_mount["root"] != fresh_mount["root"]):
                raise ValueError("target and helper nested volume mount rows differ")
            if not _same_path_identity(actual_stat, fresh_stat):
                raise ValueError("nested target and helper directories differ")
            protected_device = control_before["device"]
            if protected_device != ledger_before["device"] or actual_stat["device"] != protected_device:
                raise ValueError("nested volume is not on the protected control and ledger device")
            if (_device_from_text(actual_mount["device"]) != protected_device
                    or _device_from_text(fresh_mount["device"]) != protected_device):
                raise ValueError("nested volume mount rows do not use the protected data device")
            for protected_role in ("helper_control", "helper_ledger"):
                if _mount_roots_overlap(fresh_mount["root"], selected[protected_role]["root"]):
                    raise ValueError("nested volume kernel root overlaps protected control or ledger")
            nested_initial.append({
                "mount": item, "actual_fds": actual_fds, "actual_stat": actual_stat,
                "fresh_fd": fresh_fd, "fresh_stat": fresh_stat,
                "actual_mount": actual_mount, "fresh_mount": fresh_mount,
            })
        marker_before = _read_reference_marker(reference_fd, request["reference_marker_sha256"])
        if (reference_root_before["device"] != request["reference_device"]
                or reference_root_before["inode"] != request["reference_inode"]):
            raise ValueError("reference root differs from its host-pinned device/inode")

        helper_candidate = selected["helper_candidate"]
        if candidate_before["device"] != _device_from_text(helper_candidate["device"]):
            raise ValueError("candidate stat device differs from helper mountinfo")
        for role, record, mount_key in (
                ("reference", reference_open, "helper_reference"),
                ("control", control_before, "helper_control"),
                ("ledger", ledger_before, "helper_ledger")):
            row = selected[mount_key]
            if record["device"] != _device_from_text(row["device"]):
                raise ValueError(role + " stat device differs from helper mountinfo")
        if actual_before["device"] != _device_from_text(selected["target_destination"]["device"]):
            raise ValueError("target destination stat device differs from target mountinfo")
        if (candidate_before["device"], candidate_before["inode"], candidate_before["type"]) != (
                actual_before["device"], actual_before["inode"], actual_before["type"]):
            raise ValueError("candidate and authenticated process destination identities differ")

        vpd_before = {
            "reference": _read_vpd(reference_open["device"]),
            "control": _read_vpd(control_before["device"]),
            "ledger": _read_vpd(ledger_before["device"]),
        }
        marker_after = _read_reference_marker(reference_fd, request["reference_marker_sha256"])
        actual_fds_after = _open_path_at_root(root_fd, request["destination"])
        owned_fds.extend(actual_fds_after)
        actual_after = _stat_record(os.fstat(actual_fds_after[-1]))
        nested_evidence = []
        for initial in nested_initial:
            item = initial["mount"]
            actual_fds = _open_path_at_root(root_fd, item["destination"])
            owned_fds.extend(actual_fds)
            actual_stat_after = _stat_record(os.fstat(actual_fds[-1]))
            fresh_fd_after, fresh_stat_after = _open_helper_path(item["probe_path"], True)
            owned_fds.append(fresh_fd_after)
            pinned_fresh_after = _stat_record(os.fstat(initial["fresh_fd"]))
            if actual_stat_after["type"] != "directory" or fresh_stat_after["type"] != "directory":
                raise ValueError("nested volume directory type changed")
            if (not _same_path_identity(initial["actual_stat"], actual_stat_after)
                    or not _same_path_identity(initial["fresh_stat"], fresh_stat_after)
                    or not _same_path_identity(initial["fresh_stat"], pinned_fresh_after)
                    or not _same_path_identity(actual_stat_after, fresh_stat_after)):
                raise ValueError("nested volume directory identity drifted")
            nested_evidence.append({
                "mount": item,
                "actual_stat_before": initial["actual_stat"],
                "actual_stat_after": actual_stat_after,
                "fresh_stat_before": initial["fresh_stat"],
                "fresh_stat_after": fresh_stat_after,
                "actual_mount": initial["actual_mount"],
                "fresh_mount": initial["fresh_mount"],
            })
        candidate_after = _stat_record(os.fstat(candidate_fd))
        reference_root_after = _stat_cookie(os.fstat(reference_fd))
        control_after = _stat_record(os.fstat(control_fd))
        ledger_after = _stat_record(os.fstat(ledger_fd))
        vpd_after = {
            "reference": _read_vpd(reference_open["device"]),
            "control": _read_vpd(control_before["device"]),
            "ledger": _read_vpd(ledger_before["device"]),
        }
        helper_after = _read_path("/proc/self/mountinfo", MAX_MOUNTINFO_BYTES)
        process_after = _process_snapshot(request)
        _assert_process_identity(process_after, request)
        root_cookie_after = _stat_cookie(os.fstat(root_fd))
        fresh_root_cookie_after = _fresh_proc_root_cookie(request["pid"])
        if (not _same_process_snapshot(process_before, process_after)
                or helper_before != helper_after
                or root_cookie_before != root_cookie_after
                or root_cookie_after != fresh_root_cookie_after
                or candidate_before != candidate_after
                or actual_before != actual_after
                or reference_root_before != reference_root_after
                or control_before != control_after or ledger_before != ledger_after
                or marker_before != marker_after or vpd_before != vpd_after):
            raise ValueError("process, mount, candidate, marker, or protected device drifted")

        reference = {
            "device": reference_root_before["device"],
            "inode": reference_root_before["inode"],
            "mode": reference_root_before["mode"],
            "marker_sha256_before": marker_before["sha256"],
            "marker_sha256_after": marker_after["sha256"],
            "marker_size": marker_before["size"],
            "marker_stat_before": marker_before["stat"],
            "marker_stat_after": marker_after["stat"],
        }
        protected = {}
        for role, record in (("reference", reference_open), ("control", control_before), ("ledger", ledger_before)):
            protected[role] = {
                "device": record["device"], "inode": record["inode"],
                **vpd_before[role],
            }
        return {
            "schema": PROBE_SCHEMA,
            "decision": "observed",
            "request": request,
            "process": {
                "start_ticks_before": process_before["start_ticks"],
                "start_ticks_after": process_after["start_ticks"],
                "cgroup_lines_before": process_before["cgroup_lines"],
                "cgroup_lines_after": process_after["cgroup_lines"],
                "status_uid_before": process_before["status_uid"],
                "status_uid_after": process_after["status_uid"],
                "status_gid_before": process_before["status_gid"],
                "status_gid_after": process_after["status_gid"],
                "cap_prm_before": process_before["cap_prm"],
                "cap_prm_after": process_after["cap_prm"],
                "cap_eff_before": process_before["cap_eff"],
                "cap_eff_after": process_after["cap_eff"],
                "mnt_namespace_before": process_before["mnt_namespace"],
                "mnt_namespace_after": process_after["mnt_namespace"],
                "user_namespace_before": process_before["user_namespace"],
                "user_namespace_after": process_after["user_namespace"],
                "observer_user_namespace_before": process_before["observer_user_namespace"],
                "observer_user_namespace_after": process_after["observer_user_namespace"],
                "root_cookie_before": root_cookie_before,
                "root_cookie_after": root_cookie_after,
            },
            "reference": reference,
            "protected": protected,
            "mounts": {
                "helper_mountinfo_sha256_before": hashlib.sha256(helper_before).hexdigest(),
                "helper_mountinfo_sha256_after": hashlib.sha256(helper_after).hexdigest(),
                "target_mountinfo_sha256_before": hashlib.sha256(process_before["mountinfo"]).hexdigest(),
                "target_mountinfo_sha256_after": hashlib.sha256(process_after["mountinfo"]).hexdigest(),
                **{key: selected[key] for key in (
                    "helper_candidate", "helper_reference", "helper_control", "helper_ledger",
                    "target_destination", "helper_candidate_nested", "helper_reference_nested",
                    "target_destination_nested",
                )},
            },
            "candidate_stat_before": candidate_before,
            "candidate_stat_after": candidate_after,
            "actual_stat_before": actual_before,
            "actual_stat_after": actual_after,
            "nested_evidence": nested_evidence,
        }
    finally:
        _close_fds(owned_fds)


def _device_from_text(value):
    match = _DEVICE.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise ValueError("mountinfo device field is malformed")
    major, minor = (int(part) for part in value.split(":"))
    return os.makedev(major, minor)


def _main():
    import signal
    import sys

    signal.alarm(35)
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        raise ValueError("probe request is empty or over budget")
    request = _validate_request(json.loads(
        raw.decode("utf-8", "strict"), object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_json_constant,
    ))
    result = _observe(request)
    output = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(output) > MAX_OUTPUT_BYTES:
        raise ValueError("probe result exceeds its output budget")
    sys.stdout.buffer.write(output)


def _probe_source():
    preamble = """import hashlib, json, os, re, signal, stat, sys, unicodedata
PROBE_SCHEMA = 'fullmag.docker-windows-bind-probe.v1'
OWNER_MARKER = '.fullmag-linux-native-owner.json'
MAX_REQUEST_BYTES = 262144
MAX_PROC_SMALL_BYTES = 262144
MAX_MOUNTINFO_BYTES = 4194304
MAX_MOUNTINFO_RECORDS = 8192
MAX_NESTED_MOUNTS = 16
MAX_MARKER_BYTES = 1048576
MAX_VPD_BYTES = 4096
MAX_OUTPUT_BYTES = 4194304
_REQUEST_FIELDS = frozenset({'container_id','pid','uid','gid','destination','reference_device','reference_inode','reference_marker_sha256','nested_mounts'})
_DECIMAL = re.compile(r'(?:0|[1-9][0-9]*)\\Z')
_DEVICE = re.compile(r'(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)\\Z')
_HEX64 = re.compile(r'[0-9a-f]{64}\\Z')
_CONTAINER_ID = re.compile(r'[0-9a-f]{64}\\Z')
_MOUNTINFO_ESCAPES = {b'040':0x20,b'011':0x09,b'012':0x0A,b'134':0x5C}
_MOUNT_OPTION = re.compile(r'[A-Za-z0-9_+=:,.+\\-]+\\Z')
_FILESYSTEM = re.compile(r'[A-Za-z0-9_.+\\-]+\\Z')
_VOLUME_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\\Z')
_NAMESPACE = {'mnt':re.compile(r'mnt:\\[[1-9][0-9]{0,19}\\]\\Z'), 'user':re.compile(r'user:\\[[1-9][0-9]{0,19}\\]\\Z')}
"""
    functions = (
        _strict_integer, _destination_components, _validate_nested_mounts, _validate_request, _parse_pid_stat,
        _parse_process_status, _parse_cgroup, _parse_namespace, _decode_mountinfo_path,
        _safe_mount_path, _parse_mountinfo, _exact_mount_row, _mount_roots_overlap,
        _same_path_identity, _select_mount_rows,
        _validate_vpd83, _stat_record, _read_fd, _read_path, _readlink,
        _close_fds, _process_snapshot, _assert_process_identity, _same_process_snapshot, _stat_cookie,
        _open_path_at_root, _open_helper_path, _read_reference_marker, _device_text,
        _fresh_proc_root_cookie, _read_vpd, _reject_duplicate_keys, _json_constant,
        _device_from_text, _observe, _main,
    )
    return preamble + "\n".join(inspect.getsource(function) for function in functions) + (
        "\nif __name__ == '__main__':\n    _main()\n"
    )


PROBE_SOURCE = _probe_source()


def _reject_json_constant(value):
    raise ValueError("probe JSON contains a non-finite number")


def _expect_object(value, fields, label):
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(label + " fields do not match the exact schema")
    return value


def _expect_text(value, label, maximum=4096):
    if not isinstance(value, str) or len(value.encode("utf-8", "strict")) > maximum:
        raise ValueError(label + " is not bounded UTF-8 text")
    return value


def _validate_sha(value, label):
    if not isinstance(value, str) or _HEX64.fullmatch(value) is None:
        raise ValueError(label + " is not a lowercase SHA-256")
    return value


def _linux_major_minor(device):
    major = ((device >> 8) & 0xFFF) | ((device >> 32) & 0xFFFFF000)
    minor = (device & 0xFF) | ((device >> 12) & 0xFFFFFF00)
    return major, minor


def _validate_result_stat(value, label, *, expected_kind=None):
    fields = {"device", "inode", "type", "nlink", "size", "mode", "mtime_ns", "ctime_ns", "uid", "gid"}
    _expect_object(value, fields, label)
    for field in fields - {"type"}:
        _strict_integer(value[field], label + "." + field,
                        -(1 << 63) if field in {"mtime_ns", "ctime_ns"} else 0,
                        (1 << 63) - 1 if field in {"mtime_ns", "ctime_ns", "size", "nlink"}
                        else (1 << 64) - 1 if field in {"device", "inode"}
                        else (1 << 32) - 1)
    mode = value["mode"]
    kind = value["type"]
    if type(kind) is not str or kind not in {"directory", "regular-file"}:
        raise ValueError(label + ".type is unsupported")
    observed = "directory" if stat.S_ISDIR(mode) else "regular-file" if stat.S_ISREG(mode) else None
    if observed != kind or (expected_kind is not None and kind != expected_kind):
        raise ValueError(label + " type disagrees with mode or expected type")
    if value["inode"] < 1 or value["nlink"] < 1 or (kind == "regular-file" and value["nlink"] != 1):
        raise ValueError(label + " inode or hard-link count is unsafe")
    return value


def _validate_mount_row(value, label, expected_mountpoint):
    _expect_object(value, _MOUNT_ROW_FIELDS, label)
    _strict_integer(value["mount_id"], label + ".mount_id", 1, (1 << 63) - 1)
    _strict_integer(value["parent_id"], label + ".parent_id", 0, (1 << 63) - 1)
    if not isinstance(value["device"], str) or _DEVICE.fullmatch(value["device"]) is None:
        raise ValueError(label + ".device is malformed")
    if value["mountpoint"] != expected_mountpoint:
        raise ValueError(label + ".mountpoint differs from its expected exact path")
    _safe_mount_path(value["root"])
    _safe_mount_path(value["mountpoint"])
    for field in ("options", "fstype", "source", "super_options"):
        item = _expect_text(value[field], label + "." + field, 4096)
        if not item or any(unicodedata.category(char) in {"Cc", "Cf", "Cs", "Zl", "Zp"} for char in item):
            raise ValueError(label + "." + field + " is malformed")
    if _MOUNT_OPTION.fullmatch(value["options"]) is None or any(ord(char) < 33 or ord(char) > 126 for char in value["super_options"]):
        raise ValueError(label + " options are malformed")
    if _FILESYSTEM.fullmatch(value["fstype"]) is None:
        raise ValueError(label + " filesystem is malformed")
    return value


def _validate_probe_result_document(document, request):
    top_fields = {
        "schema", "decision", "request", "process", "reference", "protected", "mounts",
        "candidate_stat_before", "candidate_stat_after", "actual_stat_before", "actual_stat_after",
        "nested_evidence",
    }
    _expect_object(document, top_fields, "probe result")
    if document["schema"] != PROBE_SCHEMA or document["decision"] != "observed":
        raise ValueError("probe result schema or decision is unsupported")
    echoed_request = _validate_request(document["request"])
    if echoed_request != request:
        raise ValueError("probe result does not echo the exact request")

    process_fields = {
        "start_ticks_before", "start_ticks_after", "cgroup_lines_before", "cgroup_lines_after",
        "status_uid_before", "status_uid_after", "status_gid_before", "status_gid_after",
        "cap_prm_before", "cap_prm_after", "cap_eff_before", "cap_eff_after",
        "mnt_namespace_before", "mnt_namespace_after", "user_namespace_before", "user_namespace_after",
        "observer_user_namespace_before", "observer_user_namespace_after", "root_cookie_before",
        "root_cookie_after",
    }
    process = _expect_object(document["process"], process_fields, "process")
    for field in ("start_ticks_before", "start_ticks_after"):
        if (type(process[field]) is not str or _DECIMAL.fullmatch(process[field]) is None
                or int(process[field]) <= 0):
            raise ValueError("process start tick is malformed")
    if process["start_ticks_before"] != process["start_ticks_after"]:
        raise ValueError("process PID start tick changed")
    for field, expected in (("status_uid_before", request["uid"]),
                            ("status_uid_after", request["uid"]),
                            ("status_gid_before", request["gid"]),
                            ("status_gid_after", request["gid"])):
        values = process[field]
        if type(values) is not list or len(values) != 4 or any(type(value) is not int or value != expected for value in values):
            raise ValueError("process UID/GID four-field identity differs from request")
    for field in ("cap_prm_before", "cap_prm_after", "cap_eff_before", "cap_eff_after"):
        if type(process[field]) is not str or re.fullmatch(r"[0-9a-f]{16}", process[field]) is None or int(process[field], 16) != 0:
            raise ValueError("process capability mask is not exactly zero")
    for namespace in ("mnt", "user"):
        before = process[namespace + "_namespace_before"]
        after = process[namespace + "_namespace_after"]
        _parse_namespace(before, namespace)
        _parse_namespace(after, namespace)
        if before != after:
            raise ValueError("process namespace identity changed")
    for field in ("observer_user_namespace_before", "observer_user_namespace_after"):
        _parse_namespace(process[field], "user")
        if process[field] != process["user_namespace_before"]:
            raise ValueError("observer and target user namespaces differ")
    for field in ("cgroup_lines_before", "cgroup_lines_after"):
        lines = process[field]
        if type(lines) is not list or not lines or any(type(line) is not str for line in lines):
            raise ValueError("process cgroup evidence is malformed")
        _parse_cgroup(("\n".join(lines) + "\n").encode("ascii", "strict"), request["container_id"])
    if process["cgroup_lines_before"] != process["cgroup_lines_after"]:
        raise ValueError("process cgroup identity changed")
    root_fields = {"device", "inode", "mode"}
    root_before = _expect_object(process["root_cookie_before"], root_fields, "process root before")
    root_after = _expect_object(process["root_cookie_after"], root_fields, "process root after")
    for root in (root_before, root_after):
        _strict_integer(root["device"], "process root.device", 0)
        _strict_integer(root["inode"], "process root.inode", 1)
        _strict_integer(root["mode"], "process root.mode", 0, (1 << 32) - 1)
        if not stat.S_ISDIR(root["mode"]):
            raise ValueError("process root cookie is not a directory")
    if root_before != root_after:
        raise ValueError("authenticated proc root identity changed")

    reference_fields = {
        "device", "inode", "mode", "marker_sha256_before", "marker_sha256_after", "marker_size",
        "marker_stat_before", "marker_stat_after",
    }
    reference = _expect_object(document["reference"], reference_fields, "reference")
    _strict_integer(reference["device"], "reference.device", 0)
    _strict_integer(reference["inode"], "reference.inode", 1)
    if (reference["device"] != request["reference_device"]
            or reference["inode"] != request["reference_inode"]):
        raise ValueError("reference stat differs from host-pinned identity")
    _strict_integer(reference["mode"], "reference.mode", 0, (1 << 32) - 1)
    if not stat.S_ISDIR(reference["mode"]):
        raise ValueError("reference is not a directory")
    for field in ("marker_sha256_before", "marker_sha256_after"):
        _validate_sha(reference[field], "reference." + field)
        if reference[field] != request["reference_marker_sha256"]:
            raise ValueError("reference marker digest differs from request")
    if reference["marker_sha256_before"] != reference["marker_sha256_after"]:
        raise ValueError("reference marker changed during the observation")
    _strict_integer(reference["marker_size"], "reference.marker_size", 1, MAX_MARKER_BYTES)
    marker_before = _validate_result_stat(reference["marker_stat_before"], "reference marker before",
                                          expected_kind="regular-file")
    marker_after = _validate_result_stat(reference["marker_stat_after"], "reference marker after",
                                         expected_kind="regular-file")
    if marker_before != marker_after or marker_before["size"] != reference["marker_size"]:
        raise ValueError("reference marker stat changed")
    if marker_before["device"] != reference["device"]:
        raise ValueError("reference marker is on a nested device")

    candidate_before = _validate_result_stat(document["candidate_stat_before"], "candidate before")
    candidate_after = _validate_result_stat(document["candidate_stat_after"], "candidate after")
    actual_before = _validate_result_stat(document["actual_stat_before"], "actual destination before")
    actual_after = _validate_result_stat(document["actual_stat_after"], "actual destination after")
    if candidate_before != candidate_after or actual_before != actual_after:
        raise ValueError("candidate or actual destination stat changed")
    if (candidate_before["device"], candidate_before["inode"], candidate_before["type"]) != (
            actual_before["device"], actual_before["inode"], actual_before["type"]):
        raise ValueError("candidate and actual destination stat identities differ")

    protected = _expect_object(document["protected"], {"reference", "control", "ledger"}, "protected")
    mounts_fields = {
        "helper_mountinfo_sha256_before", "helper_mountinfo_sha256_after",
        "target_mountinfo_sha256_before", "target_mountinfo_sha256_after",
        "helper_candidate", "helper_reference", "helper_control", "helper_ledger",
        "target_destination", "helper_candidate_nested", "helper_reference_nested",
        "target_destination_nested",
    }
    mounts = _expect_object(document["mounts"], mounts_fields, "mounts")
    for namespace in ("helper", "target"):
        before = mounts[namespace + "_mountinfo_sha256_before"]
        after = mounts[namespace + "_mountinfo_sha256_after"]
        _validate_sha(before, namespace + " mountinfo before")
        _validate_sha(after, namespace + " mountinfo after")
        if before != after:
            raise ValueError(namespace + " mountinfo changed")
    expected_points = {
        "helper_candidate": "/candidate", "helper_reference": "/reference",
        "helper_control": "/control", "helper_ledger": "/ledger",
        "target_destination": request["destination"],
    }
    for key, path in expected_points.items():
        _validate_mount_row(mounts[key], key, path)
    for key in ("helper_candidate_nested", "helper_reference_nested"):
        if type(mounts[key]) is not list or mounts[key]:
            raise ValueError("nested protected mounts are present")
    request_nested = request["nested_mounts"]
    target_nested_rows = mounts["target_destination_nested"]
    if type(target_nested_rows) is not list or len(target_nested_rows) != len(request_nested):
        raise ValueError("target nested mount rows do not match the request")
    for row, item in zip(target_nested_rows, request_nested):
        _validate_mount_row(row, "target nested mount", item["destination"])
    for key in ("helper_candidate", "helper_reference", "helper_control", "helper_ledger"):
        helper_modes = [option for option in mounts[key]["options"].split(",") if option in {"ro", "rw"}]
        if helper_modes != ["ro"]:
            raise ValueError("helper protected mount is not read-only")
    if (mounts["helper_candidate"]["device"] != mounts["target_destination"]["device"]
            or mounts["helper_candidate"]["root"] != mounts["target_destination"]["root"]):
        raise ValueError("candidate and target mount rows differ")
    if mounts["helper_candidate"]["fstype"] != "9p" or mounts["target_destination"]["fstype"] != "9p":
        raise ValueError("candidate and target source are not exact 9p Windows bind mounts")
    target_modes = [option for option in mounts["target_destination"]["options"].split(",")
                    if option in {"ro", "rw"}]
    if len(target_modes) != 1:
        raise ValueError("target destination must have exactly one ro/rw mount option")
    nested_evidence = document["nested_evidence"]
    if type(nested_evidence) is not list or len(nested_evidence) != len(request_nested):
        raise ValueError("nested volume evidence does not cover the exact request")
    nested_fields = {
        "mount", "actual_stat_before", "actual_stat_after", "fresh_stat_before",
        "fresh_stat_after", "actual_mount", "fresh_mount",
    }
    for evidence, item, target_row in zip(nested_evidence, request_nested, target_nested_rows):
        _expect_object(evidence, nested_fields, "nested volume evidence")
        if evidence["mount"] != item:
            raise ValueError("nested volume evidence does not echo the exact request item")
        nested_actual_before = _validate_result_stat(evidence["actual_stat_before"],
                                                     "nested actual before", expected_kind="directory")
        nested_actual_after = _validate_result_stat(evidence["actual_stat_after"],
                                                    "nested actual after", expected_kind="directory")
        nested_fresh_before = _validate_result_stat(evidence["fresh_stat_before"],
                                                    "nested fresh before", expected_kind="directory")
        nested_fresh_after = _validate_result_stat(evidence["fresh_stat_after"],
                                                   "nested fresh after", expected_kind="directory")
        if (not _same_path_identity(nested_actual_before, nested_actual_after)
                or not _same_path_identity(nested_fresh_before, nested_fresh_after)
                or not _same_path_identity(nested_actual_before, nested_fresh_before)
                or not _same_path_identity(nested_actual_after, nested_fresh_after)):
            raise ValueError("nested actual/fresh directory identity drifted")
        actual_mount = _validate_mount_row(evidence["actual_mount"], "nested actual mount",
                                           item["destination"])
        fresh_mount = _validate_mount_row(evidence["fresh_mount"], "nested fresh mount",
                                          item["probe_path"])
        if actual_mount != target_row:
            raise ValueError("nested evidence target mount differs from the exact target row")
        if (actual_mount["device"] != fresh_mount["device"]
                or actual_mount["root"] != fresh_mount["root"]):
            raise ValueError("nested target and helper mount rows differ")
        helper_nested_modes = [option for option in fresh_mount["options"].split(",")
                               if option in {"ro", "rw"}]
        target_nested_modes = [option for option in actual_mount["options"].split(",")
                               if option in {"ro", "rw"}]
        if helper_nested_modes != ["ro"]:
            raise ValueError("nested helper volume mount is not read-only")
        if (len(target_nested_modes) != 1
                or target_nested_modes[0] != ("rw" if item["rw"] else "ro")):
            raise ValueError("nested target mount mode differs from the request")
        for record, row, label in ((nested_actual_before, actual_mount, "nested actual"),
                                   (nested_actual_after, actual_mount, "nested actual"),
                                   (nested_fresh_before, fresh_mount, "nested fresh"),
                                   (nested_fresh_after, fresh_mount, "nested fresh")):
            major, minor = _linux_major_minor(record["device"])
            if row["device"] != str(major) + ":" + str(minor):
                raise ValueError(label + " stat device differs from its mount row")
        if (_mount_roots_overlap(fresh_mount["root"], mounts["helper_control"]["root"])
                or _mount_roots_overlap(fresh_mount["root"], mounts["helper_ledger"]["root"])):
            raise ValueError("nested volume kernel root overlaps protected control or ledger")
        if target_row != evidence["actual_mount"]:
            raise ValueError("target nested mount table differs from nested evidence")
    for role, device in (("helper_candidate", candidate_before["device"]),
                         ("target_destination", actual_before["device"])):
        major, minor = _linux_major_minor(device)
        if mounts[role]["device"] != str(major) + ":" + str(minor):
            raise ValueError(role + " mount device differs from stat")

    protected_fields = {"device", "inode", "major", "minor", "vpd83_hex"}
    for role in ("reference", "control", "ledger"):
        item = _expect_object(protected[role], protected_fields, "protected." + role)
        for field in ("device", "inode", "major", "minor"):
            _strict_integer(item[field], "protected." + role + "." + field,
                            1 if field == "inode" else 0,
                            (1 << 64) - 1 if field in {"device", "inode"} else (1 << 32) - 1)
        if item["major"] == 0 or item["major"] == 7:
            raise ValueError("protected storage has a zero-major or loop device")
        if item["device"] == 0 or _linux_major_minor(item["device"]) != (item["major"], item["minor"]):
            raise ValueError("protected device number differs from major/minor")
        row = mounts["helper_" + role]
        if row["device"] != str(item["major"]) + ":" + str(item["minor"]):
            raise ValueError("protected device number differs from mountinfo")
        raw_hex = item["vpd83_hex"]
        if (not isinstance(raw_hex, str) or len(raw_hex) > MAX_VPD_BYTES * 2
                or len(raw_hex) % 2 or _HEX.fullmatch(raw_hex) is None):
            raise ValueError("protected VPD page is malformed")
        _validate_vpd83(bytes.fromhex(raw_hex))
    if (protected["reference"]["device"] != reference["device"]
            or protected["reference"]["inode"] != reference["inode"]):
        raise ValueError("protected reference device/inode differs from reference stat")
    if nested_evidence and protected["control"]["device"] != protected["ledger"]["device"]:
        raise ValueError("protected control and ledger are not on the same device")
    protected_data_device = protected["control"]["device"]
    for evidence in nested_evidence:
        for field in ("actual_stat_before", "actual_stat_after", "fresh_stat_before", "fresh_stat_after"):
            if evidence[field]["device"] != protected_data_device:
                raise ValueError("nested volume is not on the protected control and ledger device")
        if (_linux_major_minor(evidence["actual_stat_before"]["device"])
                != (protected["control"]["major"], protected["control"]["minor"])):
            raise ValueError("nested volume device differs from protected control and ledger")
    return document


def validate_probe_result(raw: bytes, *, container_id: str, pid: int, uid: int, gid: int,
                          destination: str, reference_device: int, reference_inode: int,
                          reference_marker_sha256: str, nested_mounts: list) -> dict:
    """Validate a serialized observer result against the complete host request."""
    expected = _validate_request({
        "container_id": container_id,
        "pid": pid,
        "uid": uid,
        "gid": gid,
        "destination": destination,
        "reference_device": reference_device,
        "reference_inode": reference_inode,
        "reference_marker_sha256": reference_marker_sha256,
        "nested_mounts": nested_mounts,
    })
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_OUTPUT_BYTES:
        raise ValueError("probe output is empty, malformed, or over budget")
    try:
        document = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=_reject_duplicate_keys,
                              parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("probe output is not valid bounded UTF-8 JSON") from error
    return _validate_probe_result_document(document, expected)
