"""Stage the declared Node bootstrap closure beside the static UI export."""

import argparse
import hashlib
import json
from pathlib import Path


RUNTIME_FILES = (
    "dev-server.mjs",
    "scripts/dev-server-public-origin.mjs",
    "scripts/resolve-pnpm-invocation.mjs",
)

EXPORT_ENTRYPOINTS = ("index.html", "workspace/index.html")


def validate_export(destination: Path):
    """Require the actual native launch route before modifying the package."""
    for name in EXPORT_ENTRYPOINTS:
        path = destination / name
        if path.resolve(strict=True) != path or not path.is_file():
            raise ValueError(f"Static UI entrypoint must be a regular file: {name}")
        if path.stat().st_size == 0:
            raise ValueError(f"Static UI entrypoint is empty: {name}")


def stage_runtime(source: Path, destination: Path):
    source = source.resolve(strict=True)
    destination = destination.resolve(strict=True)
    if not source.is_dir() or not destination.is_dir():
        raise ValueError("Runtime source and destination must be directories")
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Runtime source and destination must be separate trees")
    validate_export(destination)
    pending = []
    for name in RUNTIME_FILES:
        origin = source / name
        target = destination / name
        if origin.resolve(strict=True) != origin or not origin.is_file():
            raise ValueError(f"Runtime source must be a regular file: {name}")
        content = origin.read_bytes()
        if not content:
            raise ValueError(f"Runtime source is empty: {name}")
        if target.resolve() != target:
            raise ValueError(f"Runtime destination must not traverse a link: {name}")
        if target.exists() and not target.is_file():
            raise ValueError(f"Runtime destination is not a file: {name}")
        for parent in target.parents:
            if parent == destination:
                break
            if parent.exists() and not parent.is_dir():
                raise ValueError(f"Runtime destination parent is not a directory: {name}")
        pending.append((name, target, content))
    inventory = []
    for name, target, content in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError(f"Staged runtime hash mismatch: {name}")
        inventory.append({"path": name, "sha256": digest})
    return inventory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(stage_runtime(args.source, args.destination)))


if __name__ == "__main__":
    main()
