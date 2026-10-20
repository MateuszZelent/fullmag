"""Prove a client bind's Docker daemon path before host-namespace maintenance.

Docker Desktop may translate a WSL path when creating a bind.  An inspect
record alone does not prove that nsenter can see that path.  This bounded,
project-labelled probe verifies the same storage marker from both namespaces.
It never writes to host storage or compiles anything.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import os
from pathlib import Path
import re
import stat
import uuid

from docker_build_control import BuildControlError, canonical, docker_capture


SCHEMA = "fullmag.daemon-bind.v1"
TARGET = "/fullmag-bind-probe"
MARKER = ".fullmag-storage.json"
MAX_MARKER_BYTES = 16384


def mount_candidates(bind_mountinfo, host_mountinfo, target="/fullmag-bind-probe"):
    """Derive bounded host paths from mount identities, without filesystem scans."""
    import posixpath
    import re

    def decode(value):
        return re.sub(r"\\(040|011|012|134)", lambda match: chr(int(match[1], 8)), value)

    def safe(path):
        return (path.startswith("/") and not path.startswith("//")
                and not any(part in {".", ".."} for part in path.split("/"))
                and not any(ord(char) < 32 or ord(char) == 127 for char in path))

    def records(document, *, target_filter=None, device_filter=None):
        if len(document) > 4 * 1024 * 1024:
            raise ValueError("mountinfo exceeded its byte budget")
        found = []
        for line in document.splitlines():
            fields = line.split()
            if len(fields) < 10 or "-" not in fields[6:]:
                raise ValueError("malformed mountinfo record")
            device, root, destination = fields[2], decode(fields[3]), decode(fields[4])
            # Desktop has unrelated Windows/WSL mounts with non-POSIX roots.
            # Only the exact bind and matching-device host records participate
            # in the proof; unrelated namespaces must not block discovery.
            if target_filter is not None and destination != target_filter:
                continue
            if device_filter is not None and device != device_filter:
                continue
            if not re.fullmatch(r"[0-9]+:[0-9]+", device) or not safe(root) or not safe(destination):
                raise ValueError("unsafe relevant mountinfo record: " + repr(
                    {"device": device[:80], "root": root[:256], "destination": destination[:256]}))
            found.append({"device": device, "root": root, "destination": destination,
                          "mount_id": fields[0]})
        return found

    binds = records(bind_mountinfo, target_filter=target)
    if len(binds) != 1:
        raise ValueError("probe target has no unique mountinfo record")
    bound = binds[0]
    candidates = []
    for host in records(host_mountinfo, device_filter=bound["device"]):
        prefix = host["root"].rstrip("/") + "/"
        if bound["root"] != host["root"] and not bound["root"].startswith(prefix):
            continue
        suffix = posixpath.relpath(bound["root"], host["root"])
        path = host["destination"] if suffix == "." else posixpath.join(host["destination"], suffix)
        if not safe(path) or path == "/":
            continue
        candidates.append({"path": path, "bind_mount": bound, "host_mount": host})
        if len(candidates) > 64:
            raise ValueError("daemon bind candidates exceeded their budget")
    if not candidates:
        raise ValueError("bind device/root has no visible host mount")
    return sorted(candidates, key=lambda candidate: (len(candidate["path"]), candidate["path"]))


# Read-only verification, executed only in an already-attested immutable image.
# Host PID namespace and privilege match the subsequent host-ledger maintenance.
PROBE = inspect.getsource(mount_candidates) + r'''
import hashlib, json, os, signal, stat, sys
from pathlib import PurePosixPath
signal.alarm(60)
request = json.load(sys.stdin)
root = request["daemon_root"]
assert root.startswith("/") and not root.startswith("//") and root != "/"
assert not any(p in {".", ".."} for p in root.split("/"))
assert not any(ord(c) < 32 or ord(c) == 127 for c in root)
def fingerprint(root):
    for part in [root, *PurePosixPath(root).parents]:
        assert not stat.S_ISLNK(os.lstat(str(part)).st_mode), "bind path traverses symlink"
    path = root + "/.fullmag-storage.json"
    before = os.lstat(path)
    assert stat.S_ISREG(before.st_mode) and 0 < before.st_size <= 16384
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        assert (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino)
        data = os.read(fd, 16385)
        after = os.fstat(fd)
        assert (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        assert len(data) == opened.st_size
    finally:
        os.close(fd)
    return {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
            "device": opened.st_dev, "inode": opened.st_ino}
bound = fingerprint("/fullmag-bind-probe")
def mountinfo(path):
    with open(path, "r", encoding="utf-8") as stream:
        result = stream.read(4 * 1024 * 1024 + 1)
    assert len(result) <= 4 * 1024 * 1024, "mountinfo exceeded budget"
    return result
candidates = mount_candidates(mountinfo("/proc/self/mountinfo"), mountinfo("/proc/1/mountinfo"))
device = str(os.major(bound["device"])) + ":" + str(os.minor(bound["device"]))
assert candidates[0]["bind_mount"]["device"] == device, "bind mount device mismatch"
# Enter host mount namespace before opening the path; do not guess a Desktop prefix.
import ctypes
libc = ctypes.CDLL(None, use_errno=True)
namespace = os.open("/proc/1/ns/mnt", os.O_RDONLY)
try:
    os.chroot("/proc/1/root")
    os.chdir("/")
    if libc.setns(namespace, 0x00020000) != 0:
        raise OSError(ctypes.get_errno(), "cannot enter daemon host mount namespace")
finally:
    os.close(namespace)
matches = []
for candidate in candidates:
    try:
        observed = fingerprint(candidate["path"])
    except (OSError, AssertionError):
        continue
    if observed == bound:
        matches.append((candidate, observed))
assert matches, "no derived daemon host path matches bound marker identity"
proof, host = matches[0]
root = proof["path"]
assert host["sha256"] == request["sha256"] and host["size"] == request["size"], "local storage marker differs"
print(json.dumps({"schema": "fullmag.daemon-bind.v1", "daemon_root": root,
                  "marker": host, "mountinfo": proof,
                  "candidate_count": len(candidates), "matching_count": len(matches)}, sort_keys=True))
'''


def safe_daemon_path(value):
    if (not isinstance(value, str) or not value.startswith("/") or value.startswith("//")
            or value == "/" or value.endswith("/")
            or any(part in {".", ".."} for part in value.split("/"))
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise BuildControlError("Docker bind returned an unsafe daemon path; resources retained")
    return value


def _marker(root):
    # The caller has already performed durable-host-root admission. Retain
    # lexical checks here so direct use cannot resolve away a symlink.
    if not root.is_absolute() or ".." in root.parts:
        raise BuildControlError("Bind probe requires an absolute local root")
    for part in (root, *root.parents):
        if part.is_symlink():
            raise BuildControlError("Bind probe root traverses a symlink")
    marker = root / MARKER
    before = marker.lstat()
    if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_MARKER_BYTES:
        raise BuildControlError("Bind probe requires a bounded regular storage marker")
    with marker.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        data = stream.read(MAX_MARKER_BYTES + 1)
        after = os.fstat(stream.fileno())
    if ((before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
            or (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
            != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            or len(data) != before.st_size):
        raise BuildControlError("Storage marker changed during bind probe")
    document = json.loads(data)
    if (set(document) != {"schema", "project_root"}
            or document["schema"] != "fullmag_storage_v1"
            or not isinstance(document["project_root"], str) or not document["project_root"]):
        raise BuildControlError("Storage marker schema differs")
    return {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}


def _inspect(name):
    documents = json.loads(docker_capture("inspect", name).stdout)
    if not isinstance(documents, list) or len(documents) != 1:
        raise BuildControlError("Ambiguous bind probe identity; resources retained")
    return documents[0]


def resolve_daemon_bind(control, operation, local_root: Path, image: str) -> str:
    """Return an observed, marker-verified path in the daemon mount namespace.

    Every unresolved Docker outcome retains the probe for explicit recovery.
    Only a successful, inspected terminal probe is removed; named volumes and
    host data are never removed. Evidence is kept in the build-control volume.
    """
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise BuildControlError("Daemon bind probe requires an immutable image ID")
    local_root = Path(local_root)
    marker = _marker(local_root)
    token = uuid.uuid4().hex
    name = "fullmag-bind-" + token
    labels = {"com.docker.compose.project": control.project,
              "com.docker.compose.service": "daemon-bind-probe",
              "org.fullmag.daemon-bind.schema": SCHEMA,
              "org.fullmag.daemon-bind.attempt": token}
    command = ["create", "--name", name, "--interactive", "--pull", "never",
        "--network", "none", "--runtime", "runc", "--read-only", "--privileged",
        "--pid", "host", "--pids-limit", "32", "--memory", "128m", "--cpus", "0.25",
        "--env", "NVIDIA_VISIBLE_DEVICES=void", "--user", "0:0",
        "--mount", "type=bind,src=" + str(local_root) + ",dst=" + TARGET + ",readonly"]
    if "," in str(local_root) or "\n" in str(local_root) or "\r" in str(local_root):
        raise BuildControlError("Bind probe root cannot be represented safely as a Docker mount")
    for key, value in labels.items():
        command.extend(["--label", key + "=" + value])
    command.extend(["--entrypoint", "python3", image, "-c", PROBE])
    evidence_path = operation["root"] + "/daemon-bind-" + token + ".json"
    intent = {"schema": SCHEMA, "status": "preparing", "container_name": name,
              "local_root": str(local_root), "image_id": image,
              "compose_project": control.project, "expected_marker": marker}
    control.write(evidence_path, intent)
    created_id = docker_capture(*command, timeout=60).stdout.decode().strip()
    observed = _inspect(name)
    mounts = observed.get("Mounts", [])
    if (not re.fullmatch(r"[0-9a-f]{64}", created_id)
            or observed.get("Id") != created_id or observed.get("Image") != image
            or any(observed.get("Config", {}).get("Labels", {}).get(k) != v for k, v in labels.items())
            or len(mounts) != 1 or mounts[0].get("Type") != "bind"
            or mounts[0].get("Destination") != TARGET or mounts[0].get("RW") is not False):
        raise BuildControlError("Bind probe identity or readonly mount differs; resources retained")
    daemon_root = safe_daemon_path(mounts[0].get("Source"))
    control.write(evidence_path, {**intent, "status": "observing",
        "container_id": created_id, "daemon_root": daemon_root, "mount": mounts[0]})
    result = docker_capture("start", "--attach", "--interactive", created_id,
        data=canonical({"daemon_root": daemon_root, **marker}), timeout=90, allow_failure=True)
    terminal = _inspect(created_id)
    state = terminal.get("State", {})
    if (terminal.get("Id") != created_id or terminal.get("Image") != image
            or state.get("Running") is not False
            or state.get("Status") != "exited" or terminal.get("Mounts") != mounts
            or terminal.get("Config", {}).get("Labels") != observed.get("Config", {}).get("Labels")):
        raise BuildControlError("Bind probe terminal identity differs; resources retained")
    if result.returncode or state.get("ExitCode") != 0:
        control.write(evidence_path, {**intent, "status": "failed", "container_id": created_id,
            "mount": mounts[0], "state": state, "client_exit_code": result.returncode,
            "stdout": result.stdout.decode("utf-8", "replace")[:65536],
            "stderr": result.stderr.decode("utf-8", "replace")[:65536]})
        raise BuildControlError("Bind probe failed; terminal evidence recorded and container retained")
    receipt = json.loads(result.stdout)
    daemon_root = safe_daemon_path(receipt.get("daemon_root"))
    proof = receipt.get("mountinfo", {})
    if (receipt.get("schema") != SCHEMA or proof.get("path") != daemon_root
            or not isinstance(receipt.get("candidate_count"), int)
            or not 1 <= receipt["candidate_count"] <= 64
            or not isinstance(receipt.get("matching_count"), int)
            or not 1 <= receipt["matching_count"] <= receipt["candidate_count"]
            or any(receipt.get("marker", {}).get(k) != v for k, v in marker.items())
            or _marker(local_root) != marker):
        raise BuildControlError("Bind probe outcome or storage identity differs; resources retained")
    control.write(evidence_path,
        {**receipt, "status": "verified", "container_name": name,
         "local_root": str(local_root), "container_id": created_id,
         "image_id": image, "compose_project": control.project,
         "mount": mounts[0], "state": state})
    docker_capture("rm", created_id, timeout=60)
    return daemon_root
