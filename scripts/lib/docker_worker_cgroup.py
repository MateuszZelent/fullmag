#!/usr/bin/env python3
"""Delegate CPU children inside one engine-pinned backend cgroup.

Executed only by the managed, short-lived privileged Compose helper. The
application backend keeps its unprivileged user and empty capability set.
"""
from __future__ import annotations

import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import uuid

ROOT = "/opt/fullmag/worker-cgroup"
CONTROL = Path("/control")
MAX_BYTES = 16384


def fail(message: str):
    raise RuntimeError(message)


def read_json(path: Path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            fail("cgroup handshake is not a bounded regular file")
        raw = os.read(fd, MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            fail("cgroup handshake exceeds its budget")
        return json.loads(raw), raw
    finally:
        os.close(fd)


def start_token(pid: int, proc_root=Path("/proc")) -> str:
    value = (proc_root / str(pid) / "stat").read_text()
    return value[value.rfind(")") + 2:].split()[19]


def run(*args: str) -> str:
    result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=30)
    if len(result.stdout) + len(result.stderr) > 32768:
        fail("cgroup namespace command exceeded its output budget")
    return result.stdout


def main():
    if os.getuid() != 0:
        fail("cgroup maintenance requires uid 0")
    project = os.environ["FULLMAG_CGROUP_PROJECT"]
    container = os.environ["FULLMAG_CGROUP_CONTAINER_ID"]
    image = os.environ["FULLMAG_CGROUP_IMAGE_ID"]
    nonce = os.environ["FULLMAG_CGROUP_NONCE"]
    pid_text = os.environ["FULLMAG_CGROUP_BACKEND_PID"]
    if not re.fullmatch(r"fullmag-(?:master|worktree-[a-z0-9][a-z0-9-]{0,63})", project):
        fail("invalid selected Compose project")
    if not re.fullmatch(r"[0-9a-f]{64}", container):
        fail("backend must have a full engine container ID")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        fail("backend image must be immutable")
    if not re.fullmatch(r"[0-9a-f]{32}", nonce) or not re.fullmatch(r"[1-9][0-9]*", pid_text):
        fail("invalid cgroup nonce or backend PID")
    pid = int(pid_text)
    pinned_start = start_token(pid)
    request, request_bytes = read_json(CONTROL / "request.json")
    if (request.get("schema") != "fullmag.worker-cgroup-request.v1"
            or request.get("nonce") != nonce or request.get("compose_project") != project
            or request.get("boot_id") != Path("/proc/sys/kernel/random/boot_id").read_text().strip()):
        fail("backend cgroup request identity differs")
    request_pid = request.get("pid")
    if type(request_pid) is not int or request_pid < 1:
        fail("invalid backend gate PID")
    # The gate binds its request to the engine container when it can observe
    # the ID; a request naming another container is never delegated here.
    if request.get("container_id") not in (None, container):
        fail("backend cgroup request names a different container")

    # The helper has host PID visibility. Read membership in the host's cgroup
    # namespace so neither this helper's nor the backend's namespace rebases it.
    membership = run("nsenter", "-t", "1", "--cgroup", "--", "cat", f"/proc/{pid}/cgroup")
    lines = membership.strip().splitlines()
    if len(lines) != 1 or not lines[0].startswith("0::/"):
        fail("backend is not in one unified cgroup v2 hierarchy")
    relative = PurePosixPath(lines[0][3:])
    if ".." in relative.parts or "." in relative.parts:
        fail("backend cgroup path is not normalized")
    if relative.name not in (container, f"docker-{container}.scope"):
        fail("backend cgroup is not pinned to the selected container")
    host_root = Path("/proc/1/root/sys/fs/cgroup") / str(relative).lstrip("/")
    if not host_root.is_dir() or host_root.is_symlink():
        fail("selected backend cgroup is unavailable")
    root_identity = (host_root.stat().st_dev, host_root.stat().st_ino)
    controls = host_root / "fullmag-control"
    workers = host_root / "fullmag-workers"
    original_limits = {name: (host_root / name).read_text() for name in ("cpu.max", "memory.max")}
    proc_root = Path(f"/proc/{pid}/root/proc")

    def fence():
        if start_token(pid) != pinned_start:
            fail("backend engine PID was replaced")
        if read_json(CONTROL / "request.json")[1] != request_bytes:
            fail("backend gate request changed during delegation")
        if start_token(request_pid, proc_root) != str(request.get("process_start_token")):
            fail("backend gate process was replaced")
        environment = dict(item.split(b"=", 1) for item in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") if b"=" in item)
        if (environment.get(b"FULLMAG_COMPOSE_PROJECT") != project.encode()
                or environment.get(b"FULLMAG_RUNTIME_IMAGE_ID") != image.encode()):
            fail("backend process does not match selected Compose/image identity")
        if (host_root.stat().st_dev, host_root.stat().st_ino) != root_identity:
            fail("backend cgroup identity changed")
        current = run("nsenter", "-t", "1", "--cgroup", "--", "cat", f"/proc/{pid}/cgroup").strip()
        if current not in (
            f"0::{relative}", f"0::{relative}/fullmag-control",
            f"0::{relative}/fullmag-workers/control",
        ):
            fail("backend escaped its selected cgroup")
        for name, value in original_limits.items():
            if (host_root / name).read_text() != value:
                fail("outer backend cgroup limit changed")

    fence()
    if "cpu" not in (host_root / "cgroup.controllers").read_text().split():
        fail("CPU controller is not delegated to this backend")
    # An existing subtree requires an explicit recovery path. Never adopt or
    # remove unknown children, even when they have the expected spelling.
    if controls.exists() or workers.exists():
        fail("backend cgroup already contains Fullmag children; recovery required")
    controls.mkdir()
    # No-internal-processes: move only the processes already owned by this
    # exact container into its control child before enabling CPU for workers.
    for _ in range(32):
        fence()
        processes = (host_root / "cgroup.procs").read_text().split()
        if not processes:
            break
        for process in processes:
            if not process.isdecimal():
                fail("invalid backend cgroup PID")
            try:
                (controls / "cgroup.procs").write_text(process + "\n")
            except ProcessLookupError:
                pass
    if (host_root / "cgroup.procs").read_text().strip():
        fail("backend control processes did not leave the delegation root")
    fence()
    (host_root / "cgroup.subtree_control").write_text("+cpu\n")
    workers.mkdir()
    worker_control = workers / "control"
    worker_control.mkdir()
    # Both supervisors and their children must be inside the delegated tree:
    # Linux migration checks write access to the common ancestor cgroup.procs.
    # Keeping control processes in a sibling of that tree would reject worker
    # attachment even though cpu.max itself was writable.
    for _ in range(32):
        fence()
        processes = (controls / "cgroup.procs").read_text().split()
        if not processes:
            break
        for process in processes:
            if not process.isdecimal():
                fail("invalid backend control PID")
            try:
                (worker_control / "cgroup.procs").write_text(process + "\n")
            except ProcessLookupError:
                pass
    if (controls / "cgroup.procs").read_text().strip():
        fail("backend processes did not enter the delegated control child")
    controls.rmdir()
    (workers / "cgroup.subtree_control").write_text("+cpu\n")
    for path in (workers, workers / "cgroup.procs", workers / "cgroup.threads", workers / "cgroup.subtree_control",
                 worker_control / "cgroup.procs", worker_control / "cgroup.threads"):
        os.chown(path, 65532, 65532)
    # Mount only the worker subtree into the backend. Its parent quota and
    # memory limit remain outside the backend user's writable delegation.
    mount_target = Path(f"/proc/{pid}/root{ROOT}")
    metadata = mount_target.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0:
        fail("worker cgroup mountpoint is not an image-owned directory")
    fence()
    prefix = ("nsenter", "-t", str(pid), "--mount", "--cgroup", "--root", "--")
    run(*prefix, "mount", "--bind", "/sys/fs/cgroup/fullmag-workers", ROOT)
    run(*prefix, "mount", "-o", "remount,bind,rw,nosuid,nodev,noexec", ROOT)
    mounted = mount_target.stat()
    expected = workers.stat()
    if (mounted.st_dev, mounted.st_ino) != (expected.st_dev, expected.st_ino):
        fail("backend worker mount does not identify the delegated subtree")
    fence()
    result = {
        **request, "schema": "fullmag.worker-cgroup-ready.v1", "state": "ready",
        "container_id": container, "image_id": image, "backend_init_pid": pid,
        "backend_init_start_token": pinned_start, "container_cgroup": str(relative),
        "container_cgroup_device": root_identity[0], "container_cgroup_inode": root_identity[1],
        "root": ROOT, "root_device": mounted.st_dev, "root_inode": mounted.st_ino,
        "controllers": (workers / "cgroup.controllers").read_text().split(),
        "subtree_control": (workers / "cgroup.subtree_control").read_text().split(),
        "outer_limits": original_limits, "delegated_uid": 65532, "delegated_gid": 65532,
    }
    temporary = CONTROL / (".ready-" + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    try:
        os.fchown(descriptor, 0, 65532)
        with os.fdopen(descriptor, "w") as output:
            json.dump(result, output, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        destination = CONTROL / "ready.json"
        if destination.is_symlink():
            fail("worker delegation receipt is a symlink")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
