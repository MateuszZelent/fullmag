"""Refresh private managed Rust sources with preserved capsule mtimes.

Cargo's path dependency freshness uses mtimes. Never touch a live checkout,
the immutable capsule, or persistent build/cache mounts.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import time


def is_link(path: Path) -> bool:
    observed = path.lstat()
    return (stat.S_ISLNK(observed.st_mode)
            or bool(getattr(observed, "st_file_attributes", 0)
                    & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)))


def refresh(root: Path, workspace: str | None) -> dict[str, object]:
    if not workspace:
        return {"state": "not_managed", "files": 0}
    root = root.absolute()
    declared = Path(workspace).absolute()
    if root != declared or root.resolve() != root or is_link(root):
        raise ValueError("managed workspace must equal the physical working directory")
    if (root / ".git").exists() or (root / ".git").is_symlink():
        raise ValueError("refusing source timestamp changes in a Git checkout")
    for name in (".fullmag-build", ".fullmag-cargo", ".fullmag-rustup"):
        if not (root / name).is_dir() or is_link(root / name):
            raise ValueError("managed workspace is missing a persistent mountpoint")
    crates = root / "crates"
    if not crates.is_dir() or is_link(crates):
        raise ValueError("managed workspace has no regular crates directory")
    files: list[Path] = []
    def onerror(error: OSError) -> None:
        raise error
    # Validate the entire scope before touching any file; no mount traversal.
    for current, dirs, names in os.walk(crates, followlinks=False, onerror=onerror):
        for name in dirs + names:
            path = Path(current) / name
            mode = path.lstat().st_mode
            if is_link(path):
                raise ValueError("managed Rust source contains a link")
            if stat.S_ISREG(mode):
                files.append(path)
            elif not stat.S_ISDIR(mode):
                raise ValueError("managed Rust source contains a nonregular entry")
    now = time.time_ns()
    for path in files:
        observed = path.stat()
        if os.utime in os.supports_follow_symlinks:
            os.utime(path, ns=(observed.st_atime_ns, now), follow_symlinks=False)
        else:
            # Windows lacks utime's no-follow option. The private tree has
            # already been checked for both symlinks and junctions.
            os.utime(path, ns=(observed.st_atime_ns, now))
    return {"schema": "fullmag.managed-source-freshness.v1", "state": "refreshed",
            "scope": "private_workspace_crates", "files": len(files), "mtime_ns": now}


if __name__ == "__main__":
    print(json.dumps(refresh(Path.cwd(), os.environ.get("FULLMAG_RUNNER_WORKSPACE"))))
