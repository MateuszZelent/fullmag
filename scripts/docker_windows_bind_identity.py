"""Read-only Windows/WSL storage exclusion for exact Docker incarnations.

This adapter does not admit or migrate a store. It combines a native Windows
path pin with an observation of the *existing* foreign process mount and the
VPD83 identities of every protected block device. These are correlated metadata,
not an authenticated active-VM backing-file mapping. Admission is disabled until
a qualified operating-system attachment provider closes that final boundary.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import uuid

from windows_bind_identity import canonical_drive_path, pin_paths

SCHEMA = "fullmag.windows-wsl-bind-disjoint.v1"
REQUEST_SCHEMA = "fullmag.windows-wsl-bind-request.v1"
PROOF_SCOPE = "existing-live-bind-and-enumerated-nested-volumes"
MAX_BYTES = 4 * 1024 * 1024
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
PROOF_KEYS = {"schema", "decision", "proof_scope", "source", "container_id", "image_id", "started_at",
              "pid", "inspection_sha256", "engine_id", "reference_root",
              "reference_identity", "reference_marker_sha256", "reference_certificate_sha256",
              "control_volume", "ledger_volume", "native", "kernel", "foreign_inspection"}
REQUEST_KEYS = {"schema", "distro", "engine_id", "control_volume", "ledger_volume",
                "reference_root", "reference_identity", "reference_marker_sha256",
                "reference_certificate_sha256", "backend_id", "backend_image",
                "project", "container", "source"}


# Windows CreateProcess has a command-line bound. Send the frozen observer
# source and typed request over stdin, never interpolate either into shell code.
OBSERVER_BOOTSTRAP = """import json,signal,sys
signal.alarm(40)
raw=sys.stdin.buffer.read(262145)
if len(raw)>262144: raise ValueError('observer input exceeds its byte budget')
payload=json.loads(raw)
if set(payload)!={'source','request'}: raise ValueError('observer envelope differs')
namespace={'__name__':'fullmag_frozen_observer'}
exec(compile(payload['source'],'<fullmag-frozen-observer>','exec'),namespace)
result=namespace['_observe'](namespace['_validate_request'](payload['request']))
encoded=json.dumps(result,sort_keys=True,separators=(',',':')).encode('utf-8')
if len(encoded)>4194304: raise ValueError('observer output exceeds its byte budget')
sys.stdout.buffer.write(encoded)
"""


def _fail(message):
    # Import lazily: native worker must not import Linux host-specific modules.
    raise ValueError(message)


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("Duplicate JSON key")
        result[key] = value
    return result


def _parse(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_BYTES:
        _fail("Adapter response is empty or over budget")
    return json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=_pairs,
                      parse_constant=lambda _: _fail("Non-JSON numeric constant"))


def _sha(value):
    if not isinstance(value, str) or HEX64.fullmatch(value) is None or value == "0" * 64:
        _fail("Invalid SHA-256 identity")
    return value


def _text(value):
    if (not isinstance(value, str) or not value or len(value) > 4096
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        _fail("Invalid bounded identity text")
    return value


def _posix(value):
    _text(value)
    if (not value.startswith("/") or value.startswith("//")
            or str(PurePosixPath(value)) != value or ".." in PurePosixPath(value).parts
            or "\\" in value or "," in value):
        _fail("Invalid canonical POSIX path")
    return value


def _int(value, minimum=0):
    if type(value) is not int or value < minimum or value > 2**64 - 1:
        _fail("Invalid strict integer")
    return value


def _named(value):
    if not isinstance(value, str) or NAME.fullmatch(value) is None:
        _fail("Invalid Docker or distribution name")
    return value


def canonical_windows_source(source):
    """Propose a drive path; only actual/fresh kernel parity authenticates it."""
    if isinstance(source, str) and re.match(r"^[A-Za-z]:", source):
        result = canonical_drive_path(source)
        if "," in result:
            _fail("Windows source cannot be represented as an exact Docker bind")
        return result
    for prefix in ("/run/desktop/mnt/host/", "/host_mnt/", "/mnt/host/"):
        if isinstance(source, str) and source.startswith(prefix):
            _posix(source)
            tail = source[len(prefix):]
            drive, separator, rest = tail.partition("/")
            if len(drive) != 1 or not drive.isascii() or not drive.isalpha():
                _fail("Desktop drive alias has no exact drive letter")
            result = canonical_drive_path(drive.upper() + ":\\" + rest.replace("/", "\\"))
            if "," in result:
                _fail("Windows source cannot be represented as an exact Docker bind")
            return result
    _fail("Unsupported Windows source form")


def is_windows_bind_source(source):
    if not isinstance(source, str):
        return False
    if re.match(r"^[A-Za-z]:", source) is not None:
        return True
    if source.startswith("/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/"):
        return False
    return any(source == prefix.rstrip("/") or source.startswith(prefix)
               for prefix in ("/run/desktop/mnt/host/", "/host_mnt/", "/mnt/host/"))


def _mount(container, destination):
    matches = [m for m in container.get("Mounts", []) if m.get("Destination") == destination]
    if len(matches) != 1:
        _fail("Expected one exact mount at " + destination)
    return matches[0]


def _foreign_pin(container, source):
    from docker_bind_overlap_probe import _foreign_container_pin
    pin = _foreign_container_pin(container, source)
    state = pin["state"]
    config = container.get("HostConfig", {})
    # No authority escalation through process namespaces or privileged devices.
    if (state["Running"] is not True or state["Status"] != "running" or state["Pid"] <= 0
            or config.get("Privileged") is not False or config.get("PidMode") not in {"", None}
            or config.get("UsernsMode") not in {"", None} or config.get("CapAdd")
            or config.get("Devices") or config.get("DeviceCgroupRules")
            or config.get("CapDrop") != ["ALL"]
            or config.get("ReadonlyRootfs") is not True
            or "no-new-privileges:true" not in (config.get("SecurityOpt") or [])):
        _fail("Foreign process isolation is outside the qualified observer contract")
    user = container.get("Config", {}).get("User")
    if not isinstance(user, str) or re.fullmatch(r"[1-9][0-9]*:[1-9][0-9]*", user) is None:
        _fail("Foreign process requires an explicit non-root numeric UID:GID")
    uid, gid = map(int, user.split(":"))
    if max(uid, gid) > 2**31 - 1:
        _fail("Foreign UID:GID exceeds the supported range")
    mounts = [m for m in pin["mounts"] if m.get("Type") == "bind" and m.get("Source") == source]
    if len(mounts) != 1 or type(mounts[0].get("RW")) is not bool or mounts[0].get("Propagation") != "rprivate":
        _fail("Expected one private foreign bind with known access mode")
    destination = _posix(mounts[0]["Destination"])
    isolation = {key: config.get(key) for key in (
        "Privileged", "PidMode", "UsernsMode", "CapAdd", "CapDrop", "ReadonlyRootfs",
        "SecurityOpt", "Devices", "DeviceRequests", "DeviceCgroupRules")}
    pin.update(uid=uid, gid=gid, destination=destination, isolation=isolation)
    pin["sha256"] = _digest(_canonical({k: v for k, v in pin.items() if k != "sha256"}))
    return pin


def _capture(argv, data=None, timeout=60):
    from docker_build_control import bounded_capture
    result = bounded_capture(argv, data=data, timeout=timeout, maximum=MAX_BYTES)
    if result.returncode != 0:
        _fail("Read-only identity command refused: " + result.stderr.decode("utf-8", "replace")[-1500:])
    return result.stdout


def _docker(exe, *args, data=None):
    return _capture([exe, "--context", "desktop-linux", *args], data=data)


def _native_config(distro):
    import winreg
    distro = _named(distro)
    records = {}
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                        r"Software\Microsoft\Windows\CurrentVersion\Lxss") as parent:
        for index in range(winreg.QueryInfoKey(parent)[0]):
            key_name = winreg.EnumKey(parent, index)
            with winreg.OpenKey(parent, key_name) as key:
                try:
                    name = winreg.QueryValueEx(key, "DistributionName")[0]
                except FileNotFoundError:
                    continue
                if name not in {distro, "docker-desktop"}:
                    continue
                if name in records:
                    _fail("Duplicate selected WSL registry identity")
                version = winreg.QueryValueEx(key, "Version")[0]
                base = winreg.QueryValueEx(key, "BasePath")[0]
                try:
                    vhd_name = winreg.QueryValueEx(key, "VhdFileName")[0]
                except FileNotFoundError:
                    vhd_name = "ext4.vhdx"  # Documented WSL registry layout.
                if version != 2 or not isinstance(base, str) or not isinstance(vhd_name, str):
                    _fail("Selected distribution is not a WSL2 VHD-backed instance")
                if base.startswith("\\\\?\\"):
                    base = base[4:]
                base = canonical_drive_path(base.rstrip("\\"))
                if re.fullmatch(r"[A-Za-z0-9_.-]+\.vhdx", vhd_name, re.I) is None:
                    _fail("Unsupported WSL VHD filename")
                records[name] = {"registry_key": key_name, "version": version,
                                 "base": base, "vhd_name": vhd_name}
    if set(records) != {distro, "docker-desktop"}:
        _fail("Exact WSL2 distribution registrations are unavailable")
    running_raw = _capture([str(Path(os.environ["WINDIR"]) / "System32/wsl.exe"),
                            "--list", "--running", "--quiet"])
    running = {line.strip().lstrip("\ufeff") for line in running_raw.decode("utf-16-le").splitlines()}
    if not {distro, "docker-desktop"}.issubset(running):
        _fail("Required WSL distribution is stopped; adapter will not start it")
    settings_path = Path(os.environ["APPDATA"]) / "Docker/settings-store.json"
    with settings_path.open("rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    settings = _parse(raw)
    if settings.get("WslEngineEnabled") is not True:
        _fail("Docker Desktop is not configured for WSL2")
    custom = settings.get("CustomWslDistroDir")
    if not isinstance(custom, str) or not custom:
        _fail("Docker Desktop WSL data root is not explicitly observable")
    custom = canonical_drive_path(custom.rstrip("\\/"))
    paths = {
        "wsl": records[distro]["base"] + "\\" + records[distro]["vhd_name"],
        "docker_data": custom + r"\disk\docker_data.vhdx",
    }
    return {"distro": distro, "registrations": records, "vhd_paths": paths,
            "settings_sha256": _digest(raw), "settings_path": str(settings_path),
            "docker_wsl_root": custom,
            "running_selected": sorted({distro, "docker-desktop"})}


def _validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or set(snapshot) != {"candidate", "wsl", "docker_data"}:
        _fail("Native path pins are incomplete")
    seen = []
    for label, entry in snapshot.items():
        if not isinstance(entry, dict) or set(entry) != {"label", "canonical_input", "kind", "single_link", "target", "ancestors"}:
            _fail("Native path pin schema differs")
        if (not isinstance(entry["target"], dict) or entry["kind"] not in {"file", "directory"}
                or type(entry["single_link"]) is not bool):
            _fail("Native path pin type is malformed")
        if (entry["kind"] == "directory" and entry["single_link"]
                or entry["kind"] == "file" and (not entry["single_link"] or entry["target"].get("number_of_links") != 1)):
            _fail("Native path link policy differs")
        if entry["label"] != label or canonical_drive_path(entry["canonical_input"]) != entry["canonical_input"]:
            _fail("Native path pin label/path differs")
        if not isinstance(entry["ancestors"], list) or len(entry["ancestors"]) > 128:
            _fail("Native ancestor chain is malformed")
        chain = [*entry["ancestors"], entry["target"]]
        for record in chain:
            if not isinstance(record, dict) or set(record) != {"canonical_input", "final_path", "volume_guid", "volume_serial_hex", "file_id_hex", "kind", "number_of_links", "no_reparse", "filesystem", "drive_type"}:
                _fail("Native handle identity schema differs")
            if canonical_drive_path(record["canonical_input"]) != record["canonical_input"]:
                _fail("Noncanonical native component path")
            _text(record["final_path"])
            if (str(uuid.UUID(record["volume_guid"])) != record["volume_guid"]
                    or re.fullmatch(r"[0-9a-f]{16}", record["volume_serial_hex"]) is None
                    or re.fullmatch(r"[0-9a-f]{32}", record["file_id_hex"]) is None
                    or record["file_id_hex"] == "0" * 32
                    or uuid.UUID(record["volume_guid"]).int == 0
                    or record["no_reparse"] is not True or type(record["drive_type"]) is not int or record["drive_type"] != 3
                    or record["filesystem"] not in {"NTFS", "ReFS"}
                    or record["kind"] not in {"file", "directory"}):
                _fail("Native handle identity is not qualified")
            _int(record["number_of_links"], 1)
            prefix = "\\\\?\\Volume{" + record["volume_guid"] + "}\\"
            if not record["final_path"].startswith(prefix):
                _fail("Native final path does not name its exact volume")
        if entry["target"]["canonical_input"] != entry["canonical_input"]:
            _fail("Native target path differs")
        if label != "candidate" and (entry["kind"] != "file" or entry["single_link"] is not True or entry["target"]["number_of_links"] != 1):
            _fail("Protected VHD must be an unshared regular file")
        if entry["target"]["kind"] != entry["kind"]:
            _fail("Native target kind differs")
        parts = entry["canonical_input"][3:].split("\\") if len(entry["canonical_input"]) > 3 else []
        expected_paths = [entry["canonical_input"][:3]]
        expected_paths += [entry["canonical_input"][:3] + "\\".join(parts[:i]) for i in range(1, len(parts) + 1)]
        if ([record["canonical_input"] for record in chain] != expected_paths
                or any(record["kind"] != "directory" for record in chain[:-1])):
            _fail("Native pin omits or changes an ancestor")
        from windows_bind_identity import _PinnedPaths
        _PinnedPaths._validate_path_chain(chain)
        seen.append((label, entry["target"]))
    candidate = snapshot["candidate"]["target"]
    for label, backing in seen:
        if label == "candidate":
            continue
        candidate_key = (candidate["volume_serial_hex"], candidate["file_id_hex"])
        if candidate_key == (backing["volume_serial_hex"], backing["file_id_hex"]):
            _fail("Foreign bind is a protected backing file")
        left, right = candidate["final_path"].casefold().rstrip("\\"), backing["final_path"].casefold().rstrip("\\")
        if left == right or left.startswith(right + "\\") or right.startswith(left + "\\"):
            _fail("Foreign bind overlaps protected backing storage")
    return snapshot


def _stable_disk_record(record):
    from windows_vhd_identity import validate_vhdx_identity_record
    validate_vhdx_identity_record(record)
    # Payload allocation can grow during unrelated activity. All essential
    # metadata and native file identity remain pinned independently.
    return {key: value for key, value in record.items() if key != "file_size_at_open"}


def _validate_native_configuration(config, paths):
    keys = {"distro", "registrations", "vhd_paths", "settings_sha256", "settings_path",
            "running_selected", "docker_wsl_root"}
    if not isinstance(config, dict) or set(config) != keys:
        _fail("Native backing configuration schema differs")
    distro = _named(config["distro"])
    if distro == "docker-desktop":
        _fail("Reference distribution is not an independent user distribution")
    _sha(config["settings_sha256"])
    if canonical_drive_path(config["settings_path"]) != config["settings_path"]:
        _fail("Docker settings path is not canonical")
    data_root = canonical_drive_path(config["docker_wsl_root"])
    if data_root != config["docker_wsl_root"]:
        _fail("Docker WSL data root is not canonical")
    registrations = config["registrations"]
    if (not isinstance(registrations, dict) or set(registrations) != {distro, "docker-desktop"}
            or config["running_selected"] != sorted({distro, "docker-desktop"})):
        _fail("Selected WSL registrations are incomplete")
    for record in registrations.values():
        if not isinstance(record, dict) or set(record) != {"registry_key", "version", "base", "vhd_name"}:
            _fail("WSL registration schema differs")
        registry_id = record["registry_key"]
        if (not isinstance(registry_id, str) or len(registry_id) != 38
                or registry_id[0] != "{" or registry_id[-1] != "}"
                or str(uuid.UUID(registry_id[1:-1])) != registry_id[1:-1].lower()
                or uuid.UUID(registry_id[1:-1]).int == 0
                or type(record["version"]) is not int or record["version"] != 2
                or canonical_drive_path(record["base"]) != record["base"]
                or not isinstance(record["vhd_name"], str)
                or re.fullmatch(r"[A-Za-z0-9_.-]+\.vhdx", record["vhd_name"], re.I) is None):
            _fail("WSL registration is not an exact VHD-backed version 2 identity")
    if len({r["registry_key"].lower() for r in registrations.values()}) != 2:
        _fail("WSL registration identities collide")
    expected = {"wsl": registrations[distro]["base"].rstrip("\\") + "\\" + registrations[distro]["vhd_name"],
                "docker_data": data_root.rstrip("\\") + r"\disk\docker_data.vhdx"}
    if config["vhd_paths"] != expected:
        _fail("VHD paths differ from the exact native configuration")
    for label, path in expected.items():
        if paths[label]["canonical_input"] != path:
            _fail("Protected native handle is not the configured backing file")


def _validate_foreign_record(foreign, source):
    keys = {"id", "image", "mounts", "host_mounts", "binds", "state", "sha256",
            "uid", "gid", "destination", "isolation"}
    isolation_keys = {"Privileged", "PidMode", "UsernsMode", "CapAdd", "CapDrop", "ReadonlyRootfs",
                      "SecurityOpt", "Devices", "DeviceRequests", "DeviceCgroupRules"}
    if (not isinstance(foreign, dict) or set(foreign) != keys
            or not isinstance(foreign["isolation"], dict) or set(foreign["isolation"]) != isolation_keys
            or not isinstance(foreign["state"], dict)
            or set(foreign["state"]) != {"StartedAt", "Status", "Running", "Pid"}):
        _fail("Full foreign incarnation schema differs")
    uid, gid = _int(foreign["uid"], 1), _int(foreign["gid"], 1)
    reconstructed = {"Id": foreign["id"], "Image": foreign["image"], "Mounts": foreign["mounts"],
                     "Config": {"User": f"{uid}:{gid}", "Labels": {}}, "State": foreign["state"],
                     "HostConfig": {**foreign["isolation"], "Mounts": foreign["host_mounts"], "Binds": foreign["binds"]}}
    if _foreign_pin(reconstructed, source) != foreign:
        _fail("Full foreign incarnation is inconsistent with its authenticated snapshot")
    destinations = [_posix(m.get("Destination")) for m in foreign["mounts"]]
    if len(set(destinations)) != len(destinations):
        _fail("Foreign mount inventory contains duplicate destinations")
    return foreign


def _validate_request(request):
    if not isinstance(request, dict) or set(request) != REQUEST_KEYS or request["schema"] != REQUEST_SCHEMA:
        _fail("Native request schema differs")
    canonical_windows_source(request["source"])
    _posix(request["reference_root"])
    for key in ("distro", "control_volume", "ledger_volume", "project"):
        _named(request[key])
    _text(request["engine_id"])
    _sha(request["backend_id"])
    if not isinstance(request["backend_image"], str) or not request["backend_image"].startswith("sha256:"):
        _fail("Native backend image is not immutable")
    _sha(request["backend_image"][7:])
    for key in ("reference_marker_sha256", "reference_certificate_sha256"):
        _sha(request[key])
    identity = request["reference_identity"]
    if not isinstance(identity, dict) or set(identity) != {"device", "inode"}:
        _fail("Native request reference identity schema differs")
    _int(identity["device"], 1)
    _int(identity["inode"], 1)
    if not isinstance(request["container"], dict):
        _fail("Native request has no foreign incarnation")
    _sha(request["container"].get("id"))
    return request


def _nested_mounts(pin):
    prefix = pin["destination"].rstrip("/") + "/"
    nested = sorted([m for m in pin["mounts"] if m.get("Destination", "").startswith(prefix)],
                    key=lambda m: m["Destination"])
    if len(nested) > 16 or len({m["Destination"] for m in nested}) != len(nested):
        _fail("Foreign nested mount inventory is over budget or duplicated")
    result = []
    for index, mount in enumerate(nested):
        if (mount.get("Type") != "volume" or mount.get("Driver") != "local"
                or type(mount.get("RW")) is not bool):
            _fail("Only exact local named volumes may shadow a Windows bind")
        result.append({"type": "volume", "destination": _posix(mount["Destination"]),
                       "source": _posix(mount.get("Source")), "name": _named(mount.get("Name")),
                       "rw": mount["RW"], "probe_path": "/nested-" + str(index)})
    return result


def _volume_pin(value, expected):
    if not isinstance(value, dict):
        _fail("Nested volume inspection is missing")
    fields = {key: value.get(key) for key in ("Name", "Driver", "Options", "Mountpoint", "Scope", "CreatedAt")}
    if (fields["Name"] != expected["name"] or fields["Driver"] != "local"
            or fields["Options"] not in (None, {}) or fields["Scope"] != "local"
            or fields["Mountpoint"] != expected["source"]):
        _fail("Nested named volume has an unknown or bind-option backing")
    _text(fields["CreatedAt"])
    return fields


def _native_worker(request):
    if os.name != "nt" or not isinstance(request, dict) or set(request) != REQUEST_KEYS or request["schema"] != REQUEST_SCHEMA:
        _fail("Native worker requires an exact request on Windows")
    from docker_windows_bind_probe import PROBE_SOURCE, validate_probe_result
    from windows_vhd_identity import read_vhdx_virtual_disk_id, parse_msft_vpd83
    exe = shutil.which("docker.exe")
    if not exe:
        _fail("Native Windows Docker executable is unavailable")
    context = _parse(_docker(exe, "context", "inspect", "desktop-linux"))
    endpoint = context[0]["Endpoints"]["docker"]["Host"]
    if endpoint != "npipe:////./pipe/dockerDesktopLinuxEngine":
        _fail("Windows observer requires the local Docker Desktop Linux pipe")
    engine = _parse(_docker(exe, "info", "--format", "{{json .}}"))["ID"]
    if engine != request["engine_id"]:
        _fail("Windows and WSL Docker engines differ")
    _validate_request(request)
    selected = _parse(_docker(exe, "inspect", request["backend_id"]))[0]
    labels = selected.get("Config", {}).get("Labels", {})
    if (selected.get("Id") != request["backend_id"] or selected.get("Image") != request["backend_image"]
            or labels.get("com.docker.compose.project") != request["project"]
            or labels.get("com.docker.compose.service") != "backend"):
        _fail("Selected immutable backend identity changed")
    volume_paths = {}
    for role, target in (("control", "/opt/fullmag/control"), ("ledger", "/host-ledger")):
        name = request[role + "_volume"]
        mount = _mount(selected, target)
        volume = _parse(_docker(exe, "volume", "inspect", name))[0]
        if (mount.get("Type") != "volume" or mount.get("Name") != name
                or volume.get("Name") != name or volume.get("Driver") != "local"
                or volume.get("Options") or mount.get("Source") != volume.get("Mountpoint")):
            _fail("Protected Docker volume has an unknown backing topology")
        volume_paths[role] = _posix(volume["Mountpoint"])
    before = _foreign_pin(_parse(_docker(exe, "inspect", request["container"]["id"]))[0], request["source"])
    if before != request["container"]:
        _fail("Foreign incarnation changed before native observation")
    nested = _nested_mounts(before)
    nested_volumes = {m["name"]: _volume_pin(_parse(_docker(exe, "volume", "inspect", m["name"]))[0], m)
                      for m in nested}
    config = _native_config(request["distro"])
    candidate = canonical_windows_source(request["source"])
    # Get the kind while pinning; no fallback follows links or aliases.
    candidate_kind = "directory" if Path(candidate).is_dir() else "file"
    paths = [{"label": "candidate", "path": candidate, "kind": candidate_kind,
              "single_link": candidate_kind == "file"}]
    paths += [{"label": name, "path": path, "kind": "file", "single_link": True}
              for name, path in config["vhd_paths"].items()]
    with pin_paths(paths) as pins:
        native_paths = _validate_snapshot(pins.snapshot())
        disks = {name: read_vhdx_virtual_disk_id(path) for name, path in config["vhd_paths"].items()}
        reference = request["reference_root"]
        reference_unc = "\\\\wsl.localhost\\" + request["distro"] + reference.replace("/", "\\")
        probe_request = {"container_id": before["id"], "pid": before["state"]["Pid"],
                         "uid": before["uid"], "gid": before["gid"], "destination": before["destination"],
                         "reference_device": request["reference_identity"]["device"],
                         "reference_inode": request["reference_identity"]["inode"],
                         "reference_marker_sha256": request["reference_marker_sha256"], "nested_mounts": nested}
        mount_ro = ",readonly,bind-propagation=rprivate,bind-recursive=readonly"
        args = ["run", "--rm", "-i", "--pull", "never", "--network", "none", "--runtime", "runc",
                "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--pid=host", "--pids-limit", "32", "--memory", "64m", "--cpus", "0.25",
                "--env", "NVIDIA_VISIBLE_DEVICES=void", "--user", f"{before['uid']}:{before['gid']}",
                "--label", "com.docker.compose.project=" + request["project"],
                "--label", "com.docker.compose.service=host-runtime-maintenance",
                "--label", "org.fullmag.compose.project=" + request["project"],
                "--mount", "type=bind,src=" + candidate + ",dst=/candidate" + mount_ro,
                "--mount", "type=bind,src=" + reference_unc + ",dst=/reference" + mount_ro,
                "--mount", "type=bind,src=" + volume_paths["control"] + ",dst=/control" + mount_ro,
                "--mount", "type=bind,src=" + volume_paths["ledger"] + ",dst=/ledger" + mount_ro,
                "--entrypoint", "/usr/local/bin/python3", request["backend_image"], "-B", "-c", OBSERVER_BOOTSTRAP]
        index = args.index("--entrypoint")
        extra = []
        for mount in nested:
            extra += ["--mount", "type=bind,src=" + mount["source"] + ",dst=" + mount["probe_path"] + mount_ro]
        args[index:index] = extra
        raw = _docker(exe, *args, data=_canonical({"source": PROBE_SOURCE, "request": probe_request}))
        kernel = validate_probe_result(raw, **probe_request)
        # Active kernel VPD83 is compared with all 128 bits of the VHD identity.
        # It is never reconstructed from a truncated NAA or a guessed drive path.
        disk_ids = {name: value["virtual_disk_id"] for name, value in disks.items()}
        if len(set(disk_ids.values())) != len(disk_ids):
            _fail("Selected VHDs have duplicate virtual disk identities")
        for name, record in kernel["protected"].items():
            actual = parse_msft_vpd83(bytes.fromhex(record["vpd83_hex"]))
            allowed = {disk_ids["wsl"]} if name == "reference" else {disk_ids["docker_data"]}
            if actual not in allowed:
                _fail("Protected kernel device does not match its selected native VHD")
        if config != _native_config(request["distro"]):
            _fail("Native backing configuration changed during observation")
        after_disks = {name: read_vhdx_virtual_disk_id(path) for name, path in config["vhd_paths"].items()}
        if ({name: _stable_disk_record(value) for name, value in disks.items()}
                != {name: _stable_disk_record(value) for name, value in after_disks.items()}):
            _fail("VHD identity metadata changed during observation")
        if any(_volume_pin(_parse(_docker(exe, "volume", "inspect", m["name"]))[0], m) != nested_volumes[m["name"]] for m in nested):
            _fail("Nested volume identity changed during observation")
        pins.verify_unchanged()
        after = _foreign_pin(_parse(_docker(exe, "inspect", before["id"]))[0], request["source"])
        if before != after or _parse(_docker(exe, "info", "--format", "{{json .}}"))["ID"] != engine:
            _fail("Foreign incarnation or Docker engine changed during observation")
    return {"configuration": config, "paths": native_paths, "disks": disks,
            "endpoint": endpoint, "kernel": kernel, "nested_volumes": nested_volumes}


def _validate_foreign_windows_bind_disjoint_proof(proof, *, source, container_id,
                                                 reference_root, control_volume,
                                                 ledger_volume, engine_id):
    if not isinstance(proof, dict) or set(proof) != PROOF_KEYS or proof["schema"] != SCHEMA or proof["decision"] != "disjoint" or proof["proof_scope"] != PROOF_SCOPE:
        _fail("Windows bind proof has no exact typed disjoint decision")
    expected = {"source": source, "container_id": container_id, "reference_root": str(reference_root),
                "control_volume": control_volume, "ledger_volume": ledger_volume, "engine_id": engine_id}
    if any(proof[key] != value for key, value in expected.items()):
        _fail("Windows bind proof belongs to different protected resources")
    canonical_windows_source(source)
    _sha(container_id)
    _posix(proof["reference_root"])
    _named(control_volume)
    _named(ledger_volume)
    for key in ("inspection_sha256", "reference_marker_sha256", "reference_certificate_sha256"):
        _sha(proof[key])
    _int(proof["pid"], 1)
    _text(proof["started_at"])
    if not isinstance(proof["image_id"], str) or not proof["image_id"].startswith("sha256:"):
        _fail("Windows bind proof image is not immutable")
    _sha(proof["image_id"][7:])
    if not isinstance(proof["reference_identity"], dict) or set(proof["reference_identity"]) != {"device", "inode"}:
        _fail("Reference identity schema differs")
    _int(proof["reference_identity"]["device"], 1)
    _int(proof["reference_identity"]["inode"], 1)
    native = proof["native"]
    if not isinstance(native, dict) or set(native) != {"configuration", "paths", "disks", "endpoint", "nested_volumes"}:
        _fail("Native proof schema differs")
    if native["endpoint"] != "npipe:////./pipe/dockerDesktopLinuxEngine":
        _fail("Native endpoint is not local Desktop Linux")
    _validate_snapshot(native["paths"])
    _validate_native_configuration(native["configuration"], native["paths"])
    if native["paths"]["candidate"]["canonical_input"] != canonical_windows_source(source):
        _fail("Native candidate differs from the exact source")
    # Reuse the observer's strict validation, not a truthy nested decision.
    from docker_windows_bind_probe import validate_probe_result
    from windows_vhd_identity import parse_msft_vpd83
    kernel = proof["kernel"]
    observed = kernel["request"]
    foreign = _validate_foreign_record(proof["foreign_inspection"], source)
    if (not isinstance(foreign, dict) or foreign.get("id") != container_id
            or foreign.get("sha256") != proof["inspection_sha256"]
            or _digest(_canonical({k: v for k, v in foreign.items() if k != "sha256"})) != proof["inspection_sha256"]):
        _fail("Full foreign inspection is not bound to the proof")
    if (foreign["image"] != proof["image_id"] or foreign["state"]["StartedAt"] != proof["started_at"]
            or foreign["state"]["Pid"] != proof["pid"]
            or observed["uid"] != foreign["uid"] or observed["gid"] != foreign["gid"]
            or observed["destination"] != foreign["destination"]):
        _fail("Observer and proof do not describe the same full foreign incarnation")
    target = kernel["mounts"]["target_destination"]
    selected = next(m for m in foreign["mounts"] if m["Destination"] == foreign["destination"])
    if ("rw" in target["options"].split(",")) != selected["RW"]:
        _fail("Actual foreign mount access mode differs from Docker inspection")
    nested = _nested_mounts(foreign)
    if observed["nested_mounts"] != nested or set(native["nested_volumes"]) != {m["name"] for m in nested}:
        _fail("Kernel nested coverage differs from the same full foreign inspection")
    for mount in nested:
        _volume_pin(native["nested_volumes"][mount["name"]], mount)
        if mount["name"] in {control_volume, ledger_volume}:
            _fail("Nested volume references protected resources")
    if observed["container_id"] != container_id or observed["pid"] != proof["pid"]:
        _fail("Observer proof belongs to another process")
    if (observed["reference_device"] != proof["reference_identity"]["device"]
            or observed["reference_inode"] != proof["reference_identity"]["inode"]
            or observed["reference_marker_sha256"] != proof["reference_marker_sha256"]):
        _fail("Observer proof belongs to another reference")
    validate_probe_result(_canonical(kernel), **observed)
    disks = native["disks"]
    if not isinstance(disks, dict) or set(disks) != {"wsl", "docker_data"}:
        _fail("Native VHD inventory is incomplete")
    ids = {name: _stable_disk_record(item)["virtual_disk_id"] for name, item in disks.items()}
    if len(set(ids.values())) != len(ids):
        _fail("Native VHD identities collide")
    for name, record in kernel["protected"].items():
        actual = parse_msft_vpd83(bytes.fromhex(record["vpd83_hex"]))
        allowed = {ids["wsl"]} if name == "reference" else {ids["docker_data"]}
        if actual not in allowed:
            _fail("Native VHD identity differs from the active protected device")
    return proof


def validate_foreign_windows_bind_disjoint_proof(proof, **expected):
    # Malformed evidence is always a refusal, including malformed nested types.
    from docker_build_control import BuildControlError
    try:
        _validate_foreign_windows_bind_disjoint_proof(proof, **expected)
        _require_active_backing_attestation()
    except (ValueError, TypeError, KeyError, AttributeError, StopIteration, BuildControlError) as error:
        raise ValueError("Windows bind proof refused: " + str(error)) from error


def _require_active_backing_attestation():
    # Matching VirtualDiskId is insufficient: a detached clone can carry the
    # same UUID while configuration points at it and the VM still uses another
    # file. A user flag or a self-asserted JSON field must not authorize recovery.
    _fail("Active VM backing-file identity is not qualified; configuration and matching VHD/VPD83 IDs are correlation only")


def prove_foreign_windows_bind_disjoint(control, backend, container, source, reference_root):
    from docker_build_control import BuildControlError, docker_capture
    from docker_bind_overlap_probe import (_canonical_reference_root, _host_reference_identity,
                                          _archive_foreign_proof)
    import linux_native_host as host
    try:
        _require_active_backing_attestation()
        if os.name == "nt" or not sys.platform.startswith("linux"):
            _fail("Windows/WSL proof requires the selected Linux/WSL controller")
        canonical_windows_source(source)
        root = _canonical_reference_root(reference_root)
        marker = _host_reference_identity(root)
        certificate = host.read_owned_regular(root / host.CERTIFICATE_NAME)
        certificate_doc = _parse(certificate)
        engine = _parse(docker_capture("info", "--format", "{{json .}}").stdout)["ID"]
        if (certificate_doc.get("schema") != host.HOST_SCHEMA
                or certificate_doc.get("storage_profile") != host.PROFILE
                or certificate_doc.get("role") != "session"
                or certificate_doc.get("host_root") != str(root)
                or certificate_doc.get("host_inode") != marker["root_inode"]
                or certificate_doc.get("host_platform") != "linux"):
            _fail("Retained reference certificate is not the selected Linux store")
        # host_device may be stale after a WSL restart. Readmission is a
        # separate guarded operation; this proof records current kernel identity.
        if certificate_doc.get("engine_id") != engine:
            _fail("Retained reference certificate belongs to another engine")
        if certificate_doc != _parse(host.read_owned_regular(root / host.OWNER_NAME)):
            _fail("Retained certificate and owner marker differ")
        labels = backend.get("Config", {}).get("Labels", {})
        if labels.get("com.docker.compose.project") != control.project or labels.get("com.docker.compose.service") != "backend":
            _fail("Reference backend does not belong to the selected group")
        selected_control, selected_ledger = _mount(backend, "/opt/fullmag/control"), _mount(backend, "/host-ledger")
        if selected_control.get("Type") != "volume" or selected_control.get("Name") != control.volume or selected_ledger.get("Type") != "volume":
            _fail("Protected control and ledger require exact named volumes")
        ledger = _named(selected_ledger.get("Name"))
        before = _foreign_pin(container, source)
        if container["Id"] == backend["Id"] or any(m.get("Name") in {control.volume, ledger} for m in container["Mounts"] if m.get("Type") == "volume"):
            _fail("Foreign consumer references protected group resources")
        distro = _named(os.environ.get("WSL_DISTRO_NAME"))
        executable = os.environ.get("FULLMAG_WINDOWS_IDENTITY_PYTHON")
        if not executable or not Path(executable).is_absolute() or not Path(executable).is_file():
            _fail("Set FULLMAG_WINDOWS_IDENTITY_PYTHON to the existing native Windows Python executable")
        script = Path(__file__).resolve()
        script_windows = _capture(["wslpath", "-w", str(script)]).decode("utf-8").strip()
        request = {"schema": REQUEST_SCHEMA, "distro": distro, "engine_id": engine,
                   "control_volume": control.volume, "ledger_volume": ledger,
                   "reference_root": str(root), "reference_identity": {"device": marker["root_device"], "inode": marker["root_inode"]},
                   "reference_marker_sha256": marker["marker_sha256"], "reference_certificate_sha256": _digest(certificate),
                   "backend_id": backend["Id"], "backend_image": backend["Image"], "project": control.project,
                   "container": before, "source": source}
        response = _parse(_capture([executable, "-B", script_windows, "--native-worker"], _canonical(request), timeout=120))
        kernel = response.pop("kernel")
        after = _foreign_pin(_parse(docker_capture("inspect", before["id"]).stdout)[0], source)
        if before != after or _host_reference_identity(root) != marker or host.read_owned_regular(root / host.CERTIFICATE_NAME) != certificate:
            _fail("Reference or foreign incarnation changed across the Windows observer")
        if _parse(docker_capture("info", "--format", "{{json .}}").stdout)["ID"] != engine:
            _fail("Controller engine changed during observation")
        proof = {"schema": SCHEMA, "decision": "disjoint", "proof_scope": PROOF_SCOPE, "source": source,
                 "container_id": before["id"], "image_id": before["image"], "started_at": before["state"]["StartedAt"],
                 "pid": before["state"]["Pid"], "inspection_sha256": before["sha256"], "engine_id": engine,
                 "reference_root": str(root), "reference_identity": request["reference_identity"],
                 "reference_marker_sha256": marker["marker_sha256"], "reference_certificate_sha256": _digest(certificate),
                 "control_volume": control.volume, "ledger_volume": ledger, "native": response, "kernel": kernel,
                 "foreign_inspection": before}
        validate_foreign_windows_bind_disjoint_proof(proof, source=source, container_id=before["id"],
            reference_root=root, control_volume=control.volume, ledger_volume=ledger, engine_id=engine)
        _archive_foreign_proof(control, proof)
        return proof
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        raise BuildControlError("Windows/WSL bind identity remains unproved: " + str(error)) from error


if __name__ == "__main__":
    if sys.argv[1:] != ["--native-worker"]:
        raise SystemExit("This module is an internal read-only native observer")
    result = _native_worker(_parse(sys.stdin.buffer.read(MAX_BYTES + 1)))
    sys.stdout.buffer.write(_canonical(result))
