#!/usr/bin/env python3
"""Bind the installed cuDSS SDK to the managed FEM dependency manifest."""
import argparse
import ctypes
from hashlib import sha256
import json
from pathlib import Path


def library_version(path: Path) -> str:
    api = ctypes.CDLL(str(path))
    property_value = api.cudssGetProperty
    property_value.argtypes = (ctypes.c_int, ctypes.POINTER(ctypes.c_int))
    property_value.restype = ctypes.c_int
    components = []
    for field in range(3):
        value = ctypes.c_int()
        status = property_value(field, ctypes.byref(value))
        if status != 0:
            raise RuntimeError(f"cudssGetProperty failed for field {field}: {status}")
        components.append(str(value.value))
    return ".".join(components)


def sha256_by_chunk(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("version")
    parser.add_argument("archive_url")
    parser.add_argument("archive_sha256")
    parser.add_argument("library", type=Path)
    args = parser.parse_args()
    library = args.library.resolve(strict=True)
    observed = library_version(library)
    if observed != args.version.rsplit(".", 1)[0]:
        raise RuntimeError(f"cuDSS library version {observed} differs from SDK {args.version}")
    dependencies = json.loads(args.manifest.read_bytes())
    if dependencies.get("schema") != "fullmag.docker.fem-gpu-dependencies.v1":
        raise RuntimeError("unexpected FEM dependency manifest schema")
    dependencies["declared"]["cudss"] = {
        "version": args.version,
        "redistribution_url": args.archive_url,
        "redistribution_archive_sha256": args.archive_sha256,
    }
    dependencies["actual"]["cudss"] = {
        "version": observed, "library_path": str(library), "library_sha256": sha256_by_chunk(library),
    }
    temporary = args.manifest.with_suffix(".cudss.tmp")
    temporary.write_text(json.dumps(dependencies, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(args.manifest)


if __name__ == "__main__":
    main()
