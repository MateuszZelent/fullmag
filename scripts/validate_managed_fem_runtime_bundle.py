#!/usr/bin/env python3
"""Fail closed when the managed FEM bundle manifest disagrees with its files."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--runtime-root", type=Path, required=True)
    args = parser.parse_args()
    runtime_root = args.runtime_root.resolve()
    manifest_path = runtime_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    binaries = manifest.get("binaries")
    integrity = manifest.get("integrity")
    if not isinstance(binaries, dict) or not isinstance(integrity, dict):
        raise ValueError("managed FEM manifest has no binaries/integrity contract")
    for name in ("launcher", "worker", "api"):
        relative = binaries.get(name)
        expected = integrity.get(f"{name}_sha256")
        if not isinstance(relative, str) or not isinstance(expected, str):
            raise ValueError(f"managed FEM manifest has no {name} path/hash")
        path = runtime_root / relative
        if not path.is_file() or not os.access(path, os.X_OK):
            raise ValueError(f"managed FEM {name} is missing or not executable: {path}")
        actual = sha256(path)
        if actual != expected:
            raise ValueError(f"managed FEM {name} hash mismatch: expected {expected}, got {actual}")
    print(json.dumps({"runtime": manifest.get("runtime"), "bundle": "valid"}, sort_keys=True))


if __name__ == "__main__":
    main()
