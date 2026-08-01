#!/usr/bin/env python3
"""Verify immutable FEM GPU runtime restore identity across a managed export."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Mapping


REPO_ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_path(value: object) -> Path:
    path = Path(str(value))
    return path.resolve() if path.is_absolute() else (REPO_ROOT / path).resolve()


def require_file(path: Path, message: str) -> None:
    if not path.is_file():
        raise ValueError(f"{message}: {path}")


def capture_restore_state(environment_path: Path) -> dict[str, object]:
    environment = json.loads(environment_path.read_text(encoding="utf-8"))
    runtime = environment.get("runtime_bundle")
    if not isinstance(runtime, Mapping):
        raise ValueError("accepted environment is missing runtime_bundle identity")
    bundle_root = repository_path(runtime.get("root"))
    if not bundle_root.is_dir():
        raise ValueError(
            "external immutable FEM GPU runtime bundle is missing; retrieve artifact "
            f"{runtime.get('artifact_uri') or runtime.get('root')}: {bundle_root}"
        )
    restore_manifest_path = repository_path(runtime.get("restore_manifest_path"))
    require_file(
        restore_manifest_path,
        "external immutable FEM GPU runtime restore sidecar is missing",
    )
    expected_restore_sha256 = str(runtime.get("restore_manifest_sha256") or "")
    actual_restore_sha256 = sha256(restore_manifest_path)
    if actual_restore_sha256 != expected_restore_sha256:
        raise ValueError(
            "runtime restore sidecar sha256 mismatch: "
            f"expected {expected_restore_sha256}, got {actual_restore_sha256}"
        )

    descriptor_path = repository_path(runtime.get("artifact_descriptor_path"))
    require_file(descriptor_path, "runtime artifact descriptor is missing")
    expected_descriptor_sha256 = str(runtime.get("artifact_descriptor_sha256") or "")
    actual_descriptor_sha256 = sha256(descriptor_path)
    if actual_descriptor_sha256 != expected_descriptor_sha256:
        raise ValueError(
            "runtime artifact descriptor sha256 mismatch: "
            f"expected {expected_descriptor_sha256}, got {actual_descriptor_sha256}"
        )
    descriptor = json.loads(descriptor_path.read_text(encoding="utf-8"))
    if descriptor.get("artifact_uri") != runtime.get("artifact_uri"):
        raise ValueError("runtime artifact descriptor URI differs from environment")
    if repository_path(descriptor.get("bundle_root")) != bundle_root:
        raise ValueError("runtime artifact descriptor bundle root differs from environment")

    subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "validate_managed_fem_runtime_bundle.py"),
            "--runtime-root",
            str(bundle_root),
        ],
        cwd=REPO_ROOT,
        check=True,
    )

    restore = json.loads(restore_manifest_path.read_text(encoding="utf-8"))
    if restore.get("schema") != "fullmag.fem_gpu.runtime_restore_manifest.v2":
        raise ValueError("unsupported FEM GPU runtime restore manifest schema")
    if repository_path(restore.get("bundle_root")) != bundle_root:
        raise ValueError("runtime restore sidecar bundle root differs from environment")
    libraries = restore.get("libraries")
    if not isinstance(libraries, Mapping) or not libraries:
        raise ValueError("runtime restore sidecar has no library identity")

    tracked_paths: dict[str, Path] = {
        "manifest.json": bundle_root / "manifest.json",
        "snapshot.json": bundle_root / "snapshot.json",
        "restore-manifest-v2.json": restore_manifest_path,
    }
    for name, raw_entry in libraries.items():
        if not isinstance(raw_entry, Mapping):
            raise ValueError(f"invalid runtime restore library entry: {name}")
        tracked_paths[f"library:{name}"] = bundle_root / str(raw_entry.get("path"))

    identities: dict[str, dict[str, object]] = {}
    for name, path in tracked_paths.items():
        require_file(path, f"runtime restore tracked file is missing ({name})")
        identities[name] = {
            "path": str(path),
            "sha256": sha256(path),
            "inode": path.stat().st_ino,
        }

    if identities["manifest.json"]["sha256"] != restore.get("manifest_sha256"):
        raise ValueError("runtime manifest sha256 differs from restore sidecar")
    if (
        identities["snapshot.json"]["sha256"]
        != restore.get("immutable_snapshot_json_sha256")
    ):
        raise ValueError("runtime snapshot sha256 differs from restore sidecar")
    for name, raw_entry in libraries.items():
        identity = identities[f"library:{name}"]
        if identity["sha256"] != raw_entry.get("sha256"):
            raise ValueError(f"{name} sha256 differs from restore sidecar")
        if identity["inode"] != raw_entry.get("inode_at_capture"):
            raise ValueError(f"{name} inode differs from restore sidecar")

    return {
        "schema": "fullmag.fem_gpu.runtime_restore_state.v1",
        "artifact_uri": runtime.get("artifact_uri"),
        "bundle_root": str(bundle_root),
        "restore_manifest_sha256": actual_restore_sha256,
        "artifact_descriptor_sha256": actual_descriptor_sha256,
        "files": identities,
    }


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("mode", choices=("capture", "compare"))
    parser.add_argument("--environment", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    try:
        current = capture_restore_state(args.environment)
        if args.mode == "capture":
            args.state.write_text(
                json.dumps(current, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            print(json.dumps({"runtime_restore": "captured", **current}, sort_keys=True))
            return
        previous = json.loads(args.state.read_text(encoding="utf-8"))
        if current != previous:
            raise ValueError(
                "immutable FEM GPU runtime snapshot changed across controlled export"
            )
        print(
            json.dumps(
                {
                    "runtime_restore": "export_invariant",
                    "artifact_uri": current["artifact_uri"],
                    "bundle_root": current["bundle_root"],
                },
                sort_keys=True,
            )
        )
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"FEM_GPU_RUNTIME_RESTORE_ERROR={exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
