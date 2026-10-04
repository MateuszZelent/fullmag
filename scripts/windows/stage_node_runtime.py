"""Inspect and stage an explicit native Windows Node distribution."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

from verify_pe_dependencies import require_x64_pe


def regular_bytes(path):
    if path.resolve(strict=True) != path or not path.is_file():
        raise ValueError(f"Node runtime input must be a regular file: {path}")
    content = path.read_bytes()
    if not content:
        raise ValueError(f"Node runtime input is empty: {path}")
    return content


def inspect_runtime(root):
    if not root.is_absolute():
        raise ValueError("Node runtime root must be absolute")
    root = root.resolve(strict=True)
    node = root / "node.exe"
    license_file = root / "LICENSE"
    node_bytes = regular_bytes(node)
    license_bytes = regular_bytes(license_file)
    require_x64_pe(node)
    result = subprocess.run([str(node), "--version"], capture_output=True,
                            text=True, timeout=15, check=True)
    version = result.stdout.strip()
    if not re.fullmatch(r"v24\.(?:1[89]|2[0-9]|[3-9][0-9])\.[0-9]+", version):
        raise ValueError(f"Unsupported packaged Node version: {version}")
    if regular_bytes(node) != node_bytes or regular_bytes(license_file) != license_bytes:
        raise ValueError("Node runtime input changed during inspection")
    return {
        "schema_version": 1,
        "kind": "bundled-windows-x64-node",
        "version": version,
        "source_root": str(root),
        "files": [
            {"source": str(node), "path": "bin/node.exe", "sha256": hashlib.sha256(node_bytes).hexdigest()},
            {"source": str(license_file), "path": "share/licenses/node-LICENSE.txt", "sha256": hashlib.sha256(license_bytes).hexdigest()},
        ],
    }


def stage_runtime(inventory, destination):
    if inventory.get("schema_version") != 1 or inventory.get("kind") != "bundled-windows-x64-node":
        raise ValueError("Invalid Node runtime inventory")
    root = Path(inventory["source_root"])
    if not root.is_absolute() or root.resolve(strict=True) != root:
        raise ValueError("Invalid Node runtime source root")
    expected = [("node.exe", "bin/node.exe"), ("LICENSE", "share/licenses/node-LICENSE.txt")]
    if len(inventory["files"]) != len(expected):
        raise ValueError("Incomplete Node runtime inventory")
    destination = destination.resolve(strict=True)
    if not destination.is_dir():
        raise ValueError("Node runtime staging destination must be a directory")
    if root == destination or root in destination.parents or destination in root.parents:
        raise ValueError("Node runtime source and staging must be separate trees")
    pending = []
    for entry, (source_name, target_name) in zip(inventory["files"], expected):
        if entry["source"] != str(root / source_name) or entry["path"] != target_name:
            raise ValueError("Unexpected Node runtime inventory path")
        content = regular_bytes(root / source_name)
        if hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise ValueError("Node runtime input changed before staging")
        target = destination / target_name
        if target.resolve() != target:
            raise ValueError("Node runtime destination traverses a link")
        for parent in target.parents:
            if parent == destination:
                break
            if parent.exists() and not parent.is_dir():
                raise ValueError("Node runtime destination parent is not a directory")
        if target.exists() and regular_bytes(target) != content:
            raise ValueError("Conflicting staged Node runtime file")
        pending.append((target, content))
    for target, content in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        if regular_bytes(target) != content:
            raise ValueError("Staged Node runtime hash mismatch")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    inspect = sub.add_parser("inspect")
    inspect.add_argument("--root", type=Path, required=True)
    inspect.add_argument("--output", type=Path, required=True)
    stage = sub.add_parser("stage")
    stage.add_argument("--inventory", type=Path, required=True)
    stage.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "inspect":
        args.output.write_text(json.dumps(inspect_runtime(args.root)), encoding="utf-8")
    else:
        stage_runtime(json.loads(args.inventory.read_text(encoding="utf-8")), args.destination)


if __name__ == "__main__":
    main()
