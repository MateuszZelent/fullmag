"""Host adapters for volume-backed Docker development on Windows and Linux/WSL."""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import sys

import fullmag_storage as storage


_LOCAL_FILESYSTEMS = frozenset({"ext4", "xfs", "btrfs"})
_WINDOWS_MOUNT_FILESYSTEMS = frozenset({"9p", "drvfs", "cifs", "smb3"})
_MOUNT_ESCAPE = re.compile(r"\\(040|011|012|134)")


def require_host():
    if os.name != "nt" and not sys.platform.startswith("linux"):
        raise ValueError("Docker development supports Windows and Linux/WSL hosts")


def docker_argv(*args):
    """Use Docker Desktop on Windows and Docker's configured endpoint on Linux."""
    require_host()
    return ["docker", *(["--context", "desktop-linux"] if os.name == "nt" else []), *args]


def _absolute_unlinked_path(path, label):
    root = Path(path)
    if not root.is_absolute() or ".." in root.parts:
        raise ValueError(f"{label} must be an absolute path without parent traversal")
    for ancestor in (root, *root.parents):
        if storage.is_link(ancestor):
            raise ValueError(f"{label} must not traverse a symlink or reparse point: {ancestor}")
    return root


def validate_host_path(path, label="host path"):
    """Validate a durable local input path before resolving away any symlinks."""
    require_host()
    root = _absolute_unlinked_path(path, label)
    if os.name == "nt":
        from windows_folder_host import local_volume as windows_local_volume
        windows_local_volume(root)
    else:
        if any(storage.inside(root, Path(prefix))
               for prefix in ("/tmp", "/var/tmp", "/run", "/dev", "/proc", "/sys")):
            raise ValueError(f"{label} requires durable local storage: {root}")
        filesystem = storage.filesystem_type(root)
        if filesystem not in _LOCAL_FILESYSTEMS:
            raise ValueError(f"{label} requires local ext4, xfs or btrfs; observed {filesystem!r}: {root}")
    return root


def validate_linux_mounts(paths):
    """Admit Linux bind sources and their submounts without walking their trees."""
    if os.name == "nt" or not paths:
        return
    require_host()
    try:
        lines = Path("/proc/self/mountinfo").read_text(
            encoding="utf-8", errors="surrogateescape"
        ).split("\n")
    except OSError as error:
        raise ValueError("Cannot read Linux mount topology for Docker DEV") from error
    mounts = []
    for line in filter(None, lines):
        left, separator, right = line.partition(" - ")
        fields, filesystem = left.split(), right.split()
        if not separator or len(fields) < 6 or len(filesystem) < 3:
            raise ValueError("Cannot parse Linux mount topology for Docker DEV")
        target = Path(_MOUNT_ESCAPE.sub(lambda match: chr(int(match[1], 8)), fields[4]))
        mounts.append((target, filesystem[0]))

    for path, label in paths.items():
        root = _absolute_unlinked_path(path, label)
        ancestors = [(target, fs) for target, fs in mounts if root.is_relative_to(target)]
        if not ancestors:
            raise ValueError(f"{label} has no Linux mount for {root}")
        # An ext4 volume mounted under /mnt is local even if the parent is 9p.
        owner_depth = max(len(target.parts) for target, _ in ancestors)
        outside_policy = (
            (target, fs) for target, fs in mounts
            if (root.is_relative_to(target) and len(target.parts) == owner_depth
                and fs not in _LOCAL_FILESYSTEMS)
            or (root in target.parents and fs in _WINDOWS_MOUNT_FILESYSTEMS)
        )
        blocked = next(outside_policy, None)
        if blocked is not None:
            target, filesystem = blocked
            raise ValueError(
                f"{label} requires Linux-local mounts; found {filesystem} at {target} for {root}"
            )


def validate_compose_binds(document):
    """Apply the Linux mount policy to the actual application bind sources."""
    if os.name == "nt":
        return
    validate_linux_mounts({
        mount["source"]: f"DEV {service} bind {mount['target']}"
        for service, config in document["services"].items()
        for mount in config.get("volumes", ())
        if mount["type"] == "bind"
    })


def local_volume(path):
    """Describe local storage without issuing a Windows certificate on Linux."""
    require_host()
    if os.name == "nt":
        from windows_folder_host import local_volume as windows_local_volume
        return windows_local_volume(path)
    root = validate_host_path(path)
    if not root.is_dir():
        raise ValueError(f"Host storage directory does not exist: {root}")
    if shutil.disk_usage(root).free < 32 * 1024**2:
        raise ValueError("Host storage has insufficient space for startup preflight")
    return {"host_root": str(root), "host_filesystem": storage.filesystem_type(root),
            "host_platform": "linux", "host_device": root.stat().st_dev,
            "host_root_no_reparse": True}
