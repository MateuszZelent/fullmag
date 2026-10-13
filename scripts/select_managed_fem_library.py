#!/usr/bin/env python3
"""Select a capsule-bound FEM library group; do not infer identity from mtime.

CMake metadata chooses the candidate. Post-build native dependency attestation
must still verify the compiled snapshot and profile before qualification.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import re
import sys


STAMP_KEY = "FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256"


def _cache_snapshot(cache: Path) -> str | None:
    values = []
    for line in cache.read_text(encoding="utf-8").splitlines():
        if line.startswith(STAMP_KEY + ":") and "=" in line:
            values.append(line.split("=", 1)[1])
    if len(values) > 1:
        raise ValueError(f"duplicate source snapshot in CMake cache: {cache}")
    return values[0] if values else None


def _library_signature(directory: Path) -> tuple:
    root = directory.resolve(strict=True)
    files = sorted(directory.glob("libfullmag_fem.so*"))
    if not files:
        raise ValueError(f"snapshot-bound CMake cache has no native FEM library: {directory}")
    signature = []
    for library in files:
        resolved = library.resolve(strict=True)
        if not resolved.is_relative_to(root) or not resolved.is_file():
            raise ValueError(f"native FEM library escapes its build directory: {library}")
        digest = hashlib.sha256()
        with resolved.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        signature.append((library.name, digest.hexdigest()))
    return tuple(signature)


def select_library(cargo_target: Path, snapshot: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{64}", snapshot):
        raise ValueError("managed FEM selection requires a lowercase SHA-256 snapshot")
    root = cargo_target.resolve(strict=True)
    candidates = []
    for cache in sorted(root.glob("release/build/fullmag-fem-sys*/**/out/native-build/CMakeCache.txt")):
        if cache.is_symlink() or not cache.resolve(strict=True).is_relative_to(root):
            raise ValueError(f"CMake cache escapes the selected Cargo target: {cache}")
        if _cache_snapshot(cache) != snapshot:
            continue
        directory = cache.parent / "backends" / "fem"
        if not directory.resolve(strict=True).is_relative_to(root):
            raise ValueError(f"native FEM library directory escapes the Cargo target: {directory}")
        candidates.append((directory, _library_signature(directory)))
    if not candidates:
        raise ValueError("no release FEM library matches the managed source snapshot")
    if any(signature != candidates[0][1] for _, signature in candidates[1:]):
        raise ValueError("ambiguous FEM libraries for the managed source snapshot")
    # Equal library groups are interchangeable; deterministic path order avoids
    # dependence on timestamps, including preserved or future-dated files.
    return candidates[0][0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cargo-target", type=Path, required=True)
    parser.add_argument("--snapshot", required=True)
    args = parser.parse_args()
    try:
        print(select_library(args.cargo_target, args.snapshot))
    except (OSError, ValueError) as error:
        print(f"managed FEM library selection failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
