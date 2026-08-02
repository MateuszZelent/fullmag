#!/usr/bin/env python3
"""Classify source changes that do not invalidate a managed FEM binary."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path
from typing import Any


NON_RUNTIME_PREFIXES = (
    ".agents/",
    ".codex/",
    ".github/",
    "docs/",
    "public_docs/",
    "scripts/test_",
)
NON_RUNTIME_FILES = {
    "AGENTS.md",
    "CHANGELOG.md",
    "README.md",
}
NON_RUNTIME_EXACT_PATHS = {
    "apps/control-room/next-env.d.ts",
    "justfile",
    "scripts/export_fem_gpu_runtime.sh",
    "scripts/capture_source_snapshot_identity.py",
    "scripts/lib/managed_fem_image_identity.sh",
    "scripts/prune_managed_fem_runtimes.sh",
    "scripts/public_docs_information_architecture.py",
    "scripts/runtime_source_change_policy.py",
}
NON_RUNTIME_SUFFIXES = (".md", ".rst", ".source-map.json")


def is_non_runtime_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return (
        normalized in NON_RUNTIME_FILES
        or normalized in NON_RUNTIME_EXACT_PATHS
        or normalized.startswith(NON_RUNTIME_PREFIXES)
        or normalized.endswith(NON_RUNTIME_SUFFIXES)
    )


def _git_paths(repo_root: Path, *args: str) -> list[str] | None:
    try:
        output = subprocess.check_output(
            ["git", *args], cwd=repo_root, text=True, stderr=subprocess.DEVNULL
        )
    except subprocess.CalledProcessError:
        return None
    return [line for line in output.splitlines() if line]


def _dirty_paths(identity: dict[str, Any]) -> list[str] | None:
    records = identity.get("git_status_porcelain_v1")
    if not isinstance(records, list):
        return None
    paths: list[str] = []
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("paths"), list):
            return None
        paths.extend(path for path in record["paths"] if isinstance(path, str))
    return paths


def _source_cache_root(repo_root: Path, snapshot_sha256: str) -> Path | None:
    override = os.environ.get("FULLMAG_RUNTIME_SOURCE_CACHE_ROOT")
    if override:
        candidate = Path(override) / f"source-cache.{snapshot_sha256}"
        return candidate if candidate.is_dir() else None

    worktree_id = f"{repo_root.name}-{hashlib.sha256(str(repo_root).encode()).hexdigest()}"
    parent = Path("/mnt/fullmag-zfn2-native/managed-fem-runtime")
    candidate = parent / worktree_id / f"source-cache.{snapshot_sha256}"
    if candidate.is_dir():
        return candidate
    matches = list(parent.glob(f"*/source-cache.{snapshot_sha256}")) if parent.is_dir() else []
    return matches[0] if len(matches) == 1 else None


def _same_source_entry(current: Path, cached: Path) -> bool:
    try:
        current_stat = current.lstat()
        cached_stat = cached.lstat()
    except FileNotFoundError:
        return not current.exists() and not cached.exists()
    if stat.S_ISLNK(current_stat.st_mode) or stat.S_ISLNK(cached_stat.st_mode):
        return (
            stat.S_ISLNK(current_stat.st_mode)
            and stat.S_ISLNK(cached_stat.st_mode)
            and os.readlink(current) == os.readlink(cached)
        )
    if not stat.S_ISREG(current_stat.st_mode) or not stat.S_ISREG(cached_stat.st_mode):
        return False
    return current.read_bytes() == cached.read_bytes()


def non_runtime_changes_only(repo_root: Path, identity: dict[str, Any], runtime_root: Path) -> bool:
    manifest_path = runtime_root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        built_commit = manifest["build_identity"]["git_commit"]
        current_commit = identity["head_commit_full"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return False
    if not isinstance(built_commit, str) or not isinstance(current_commit, str):
        return False

    changed_paths: list[str] = []
    if built_commit != current_commit:
        committed_paths = _git_paths(repo_root, "diff", "--name-only", f"{built_commit}..{current_commit}")
        if committed_paths is None:
            return False
        changed_paths.extend(committed_paths)
    dirty_paths = _dirty_paths(identity)
    if dirty_paths is None:
        return False
    source_snapshot_sha256 = manifest["build_identity"].get("source_snapshot_sha256")
    source_cache = (
        _source_cache_root(repo_root, source_snapshot_sha256)
        if isinstance(source_snapshot_sha256, str)
        else None
    )
    if source_cache is None:
        changed_paths.extend(dirty_paths)
    else:
        changed_paths.extend(
            path
            for path in dirty_paths
            if not _same_source_entry(repo_root / path, source_cache / path)
        )
    return all(is_non_runtime_path(path) for path in changed_paths)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--identity", type=Path, required=True)
    args = parser.parse_args()
    try:
        identity = json.loads(args.identity.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 1
    return 0 if non_runtime_changes_only(args.repo_root, identity, args.runtime_root) else 1


if __name__ == "__main__":
    raise SystemExit(main())
