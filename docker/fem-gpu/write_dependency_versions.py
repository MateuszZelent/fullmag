#!/usr/bin/env python3
"""Publish the pinned FEM toolchain dependency manifest without network access."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

SCHEMA = "fullmag.docker.fem-gpu-dependencies.v1"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SHA1 = re.compile(r"^[0-9a-f]{40}$")

SOURCE_SPECS = (
    ("mfem", "MFEM_REF", "MFEM_SOURCE_COMMIT", "mfem", False),
    ("libceed", "LIBCEED_REF", "LIBCEED_SOURCE_COMMIT", "libCEED", False),
    ("hypre", "HYPRE_REF", "HYPRE_SOURCE_COMMIT", "hypre", False),
    ("petsc", "PETSC_REF", "PETSC_SOURCE_COMMIT", "petsc", False),
    ("slepc", "SLEPC_REF", "SLEPC_SOURCE_COMMIT", "slepc", False),
    ("umpire", "UMPIRE_REF", "UMPIRE_SOURCE_COMMIT", "umpire", True),
)


def _env(name: str, *, required: bool = False) -> str | None:
    value = os.environ.get(name)
    if required and not value:
        raise RuntimeError(f"required dependency metadata environment is missing: {name}")
    return value or None


def _commit(path: Path) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    value = result.stdout.strip().lower()
    if not SHA1.fullmatch(value):
        raise RuntimeError(f"{path} returned an invalid source commit: {value!r}")
    return value


def _tool_version(*command: str) -> str | None:
    try:
        result = subprocess.run(
            list(command), check=True, capture_output=True, text=True, timeout=15
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return " ".join(lines)[:512] if lines else None


def _base_image() -> dict[str, str | None]:
    reference = _env("FULLMAG_CUDA_BASE_IMAGE")
    supplied_digest = _env("FULLMAG_CUDA_BASE_IMAGE_DIGEST")
    reference_digest: str | None = None
    if reference and "@sha256:" in reference:
        suffix = reference.rsplit("@sha256:", 1)[1]
        if not SHA256.fullmatch(suffix):
            raise RuntimeError("FULLMAG_CUDA_BASE_IMAGE has an invalid @sha256 digest")
        reference_digest = suffix
    digest = supplied_digest
    if digest and digest.startswith("sha256:"):
        digest = digest[7:]
    if digest and not SHA256.fullmatch(digest):
        raise RuntimeError("FULLMAG_CUDA_BASE_IMAGE_DIGEST must be a 64-character SHA-256 digest")
    if digest and not reference_digest:
        raise RuntimeError(
            "FULLMAG_CUDA_BASE_IMAGE_DIGEST requires FULLMAG_CUDA_BASE_IMAGE to use the same @sha256 digest"
        )
    if digest and reference_digest != digest:
        raise RuntimeError("FULLMAG_CUDA_BASE_IMAGE digest does not match FULLMAG_CUDA_BASE_IMAGE_DIGEST")
    return {"reference": reference, "digest": digest or reference_digest}


def _declared_dependencies() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name, ref_env, commit_env, _path, optional in SOURCE_SPECS:
        reference = _env(ref_env, required=True)
        commit = _env(commit_env, required=True)
        if not SHA1.fullmatch(commit.lower()):
            raise RuntimeError(f"{name} declared source commit is not a 40-character SHA-1: {commit!r}")
        result[name] = {
            "ref": reference,
            "commit": commit.lower(),
            "optional": optional,
        }
    return result


def _declared() -> dict[str, Any]:
    return {
        "base_image": _base_image(),
        "cuda": {
            "version": _env("CUDA_VERSION"),
            "architectures": _env("FULLMAG_CUDA_ARCHITECTURES"),
        },
        "hypre": {
            "gpu_architectures": _env("FULLMAG_HYPRE_GPU_ARCHITECTURES"),
            "memory_variant": _env("FULLMAG_HYPRE_MEMORY_VARIANT"),
        },
        "dependencies": _declared_dependencies(),
        "tools": {
            "cmake": _env("CMAKE_VERSION"),
            "node": _env("NODE_VERSION"),
            "python": _env("PYTHON_VERSION"),
            "pnpm": _env("PNPM_VERSION"),
            "rust": _env("RUST_TOOLCHAIN"),
        },
    }


def _source_commits(source_root: Path, *, required: bool) -> dict[str, str | None]:
    result: dict[str, str | None] = {}
    variant = _env("FULLMAG_HYPRE_MEMORY_VARIANT")
    for name, _ref_env, commit_env, relative, optional in SOURCE_SPECS:
        expected = _env(commit_env, required=required)
        path = source_root / relative
        if optional and variant != "umpire":
            result[name] = None
            continue
        if not path.is_dir():
            if required:
                raise RuntimeError(f"dependency source tree is missing: {path}")
            result[name] = None
            continue
        actual = _commit(path)
        if expected and actual != expected.lower():
            raise RuntimeError(
                f"{name} source commit mismatch: declared {expected}, actual {actual}"
            )
        result[name] = actual
    return result


def _tool_versions() -> dict[str, str | None]:
    return {
        "nvcc": _tool_version("nvcc", "--version"),
        "cmake": _tool_version("cmake", "--version"),
        "rustc": _tool_version("rustc", "--version"),
        "python": _tool_version("python3", "--version"),
        "node": _tool_version("node", "--version"),
        "pnpm": _tool_version("pnpm", "--version"),
    }


def _latest() -> dict[str, str]:
    return {
        "status": "not-queried",
        "policy": "Pinned refs and commits are authoritative; image builds never resolve or upgrade upstream latest.",
    }


def _write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _parse() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source-root", type=Path, default=Path("/tmp/build"))
    parser.add_argument("--phase", choices=("deps", "runtime"), required=True)
    return parser.parse_args()


def main() -> int:
    args = _parse()
    if args.phase == "deps":
        value: dict[str, Any] = {
            "schema": SCHEMA,
            "declared": _declared(),
            "actual": {
                "base_image": _base_image(),
                "source_commits": _source_commits(args.source_root, required=True),
                "tool_versions": _tool_versions(),
            },
            "latest": _latest(),
            "build": {"phase": "deps"},
        }
    else:
        try:
            value = json.loads(args.output.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as error:
            raise RuntimeError(f"cannot augment dependency manifest: {args.output}") from error
        if not isinstance(value, dict) or value.get("schema") != SCHEMA:
            raise RuntimeError(f"dependency manifest has an unexpected schema: {args.output}")
        actual = value.setdefault("actual", {})
        if not isinstance(actual, dict):
            raise RuntimeError("dependency manifest actual field must be an object")
        actual["base_image"] = _base_image()
        actual["tool_versions"] = _tool_versions()
        declared = value.setdefault("declared", {})
        if not isinstance(declared, dict):
            raise RuntimeError("dependency manifest declared field must be an object")
        declared["base_image"] = _base_image()
        tools = declared.setdefault("tools", {})
        if not isinstance(tools, dict):
            raise RuntimeError("dependency manifest declared.tools field must be an object")
        for key, env_name in ((
            ("cmake", "CMAKE_VERSION"),
            ("node", "NODE_VERSION"),
            ("python", "PYTHON_VERSION"),
            ("pnpm", "PNPM_VERSION"),
            ("rust", "RUST_TOOLCHAIN"),
        )):
            value_from_env = _env(env_name)
            if value_from_env:
                tools[key] = value_from_env
        value["latest"] = _latest()
        value["build"] = {"phase": "runtime"}
    _write(args.output, value)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"fullmag dependency manifest: {error}", file=sys.stderr)
        raise SystemExit(2)
