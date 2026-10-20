"""Host adapters for volume-backed Docker development on Windows and Linux/WSL."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import sys

import fullmag_storage as storage


def require_host():
    if os.name != "nt" and not sys.platform.startswith("linux"):
        raise ValueError("Docker development supports Windows and Linux/WSL hosts")


def docker_argv(*args):
    """Use Docker Desktop on Windows and Docker's configured endpoint on Linux."""
    require_host()
    return ["docker", *(["--context", "desktop-linux"] if os.name == "nt" else []), *args]


def validate_host_path(path, label="host path"):
    """Validate a durable local input path before resolving away any symlinks."""
    require_host()
    root = Path(path)
    if not root.is_absolute() or ".." in root.parts:
        raise ValueError(f"{label} must be an absolute path without parent traversal")
    for ancestor in (root, *root.parents):
        if storage.is_link(ancestor):
            raise ValueError(f"{label} must not traverse a symlink or reparse point: {ancestor}")
    if os.name == "nt":
        from windows_folder_host import local_volume as windows_local_volume
        windows_local_volume(root)
    else:
        if any(storage.inside(root, Path(prefix))
               for prefix in ("/tmp", "/var/tmp", "/run", "/dev", "/proc", "/sys")):
            raise ValueError(f"{label} requires durable local storage: {root}")
        filesystem = storage.filesystem_type(root)
        if filesystem not in {"ext4", "xfs", "btrfs"}:
            raise ValueError(f"{label} requires local ext4, xfs or btrfs; observed {filesystem!r}: {root}")
    return root


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
