#!/usr/bin/env python3
"""Calculate the source identity consumed by a managed FEM runtime export."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Iterable, Sequence


SOURCE_INPUT_DOMAIN = b"fullmag.managed_fem_runtime_sources.v1\0"
DIRTY_PATCH_DOMAIN = b"fullmag.managed_fem_runtime_dirty_patch.v1\0"
SOURCE_INPUT_MANIFEST = "scripts/managed_fem_runtime_source_inputs.v1.txt"


class SourceProvenanceError(ValueError):
    """The source tree cannot be represented by a safe runtime identity."""


def _git(repo_root: Path, *args: str) -> bytes:
    completed = subprocess.run(
        ["git", "-C", str(repo_root), *args], check=False, capture_output=True
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise SourceProvenanceError(f"git {' '.join(args)} failed: {detail}")
    return completed.stdout


def _relative_path(raw: str, label: str) -> Path:
    path = Path(raw)
    if not raw or path.is_absolute() or ".." in path.parts:
        raise SourceProvenanceError(
            f"{label} is not a repository-relative path: {raw!r}"
        )
    return path


def _require_within_repo(repo_root: Path, path: Path, label: str) -> Path:
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise SourceProvenanceError(f"cannot resolve {label}: {exc}") from exc
    if not resolved.is_relative_to(repo_root):
        raise SourceProvenanceError(f"{label} escapes repository: {path}")
    return resolved


def read_source_inputs(repo_root: Path, input_manifest: Path) -> tuple[Path, ...]:
    try:
        lines = input_manifest.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise SourceProvenanceError(f"cannot read source input manifest: {exc}") from exc
    if not lines or any(not line for line in lines):
        raise SourceProvenanceError(
            "source input manifest must contain one non-empty path per line"
        )
    paths = tuple(_relative_path(line, "source input") for line in lines)
    if len(set(paths)) != len(paths):
        raise SourceProvenanceError("source input manifest has duplicate paths")
    for path in paths:
        candidate = repo_root / path
        if not candidate.exists() and not candidate.is_symlink():
            raise SourceProvenanceError(f"source input does not exist: {path}")
        _require_within_repo(repo_root, candidate, f"source input {path}")
    return paths


def _relevant_git_paths(repo_root: Path, source_inputs: Sequence[Path]) -> tuple[Path, ...]:
    output = _git(
        repo_root,
        "ls-files",
        "-co",
        "--exclude-standard",
        "-z",
        "--",
        *(str(path) for path in source_inputs),
    )
    paths = tuple(
        sorted(
            (
                path
                for path in (
                    _relative_path(raw.decode("utf-8"), "git path")
                    for raw in output.split(b"\0")
                    if raw
                )
                # ``git ls-files -c`` retains tracked paths deleted from a
                # dirty worktree.  They are represented by the diff hash, not
                # as readable source records; otherwise a legitimate FM013
                # duplicate-owner deletion makes runtime export fail before
                # it can report the expected dirty-source policy.
                if (repo_root / path).exists() or (repo_root / path).is_symlink()
            ),
            key=lambda value: str(value).encode("utf-8"),
        )
    )
    if not paths:
        raise SourceProvenanceError(
            "source input manifest resolves to no tracked or untracked files"
        )
    return paths


def _write_record(digest: "hashlib._Hash", relative: Path, content: bytes) -> None:
    path_bytes = str(relative).encode("utf-8")
    digest.update(len(path_bytes).to_bytes(8, "big"))
    digest.update(path_bytes)
    digest.update(len(content).to_bytes(8, "big"))
    digest.update(content)


def _hash_records(domain: bytes, records: Iterable[tuple[Path, bytes]]) -> str:
    digest = hashlib.sha256(domain)
    for relative, content in records:
        _write_record(digest, relative, content)
    return digest.hexdigest()


def _source_records(
    repo_root: Path, paths: Sequence[Path]
) -> tuple[tuple[Path, bytes], ...]:
    records: list[tuple[Path, bytes]] = []
    for relative in paths:
        path = repo_root / relative
        _require_within_repo(repo_root, path, f"relevant source {relative}")
        if not path.is_file():
            raise SourceProvenanceError(f"relevant source is not a file: {relative}")
        try:
            records.append((relative, path.read_bytes()))
        except OSError as exc:
            raise SourceProvenanceError(
                f"cannot read relevant source {relative}: {exc}"
            ) from exc
    return tuple(records)


def _dirty_patch_hash(
    repo_root: Path, source_inputs: Sequence[Path], relevant_paths: Sequence[Path]
) -> tuple[bool, str | None]:
    path_args = tuple(str(path) for path in source_inputs)
    tracked_patch = _git(
        repo_root, "diff", "--binary", "--no-ext-diff", "HEAD", "--", *path_args
    )
    tracked = {
        _relative_path(raw.decode("utf-8"), "tracked path")
        for raw in _git(repo_root, "ls-files", "-z", "--", *path_args).split(b"\0")
        if raw
    }
    untracked = tuple(path for path in relevant_paths if path not in tracked)
    if not tracked_patch and not untracked:
        return False, None
    records: list[tuple[Path, bytes]] = [
        (Path("git-diff--binary-HEAD"), tracked_patch)
    ]
    records.extend(_source_records(repo_root, untracked))
    return True, _hash_records(DIRTY_PATCH_DOMAIN, records)


def collect_source_provenance(
    repo_root: Path, input_manifest: Path, *, allow_dirty: bool = False
) -> dict[str, object]:
    repo_root = repo_root.resolve()
    input_manifest = input_manifest.resolve()
    _require_within_repo(repo_root, input_manifest, "source input manifest")
    source_inputs = read_source_inputs(repo_root, input_manifest)
    relevant_paths = _relevant_git_paths(repo_root, source_inputs)
    source_inputs_sha256 = _hash_records(
        SOURCE_INPUT_DOMAIN, _source_records(repo_root, relevant_paths)
    )
    dirty, dirty_patch_sha256 = _dirty_patch_hash(
        repo_root, source_inputs, relevant_paths
    )
    if dirty and not allow_dirty:
        raise SourceProvenanceError(
            "relevant managed FEM runtime sources are dirty; set "
            "FULLMAG_ALLOW_DIRTY_RUNTIME_EXPORT=1 to export an explicitly dirty bundle"
        )
    git_commit = _git(repo_root, "rev-parse", "HEAD").decode("ascii").strip()
    git_tree = _git(repo_root, "rev-parse", "HEAD^{tree}").decode("ascii").strip()
    if any(
        len(value) != 40 or any(char not in "0123456789abcdef" for char in value)
        for value in (git_commit, git_tree)
    ):
        raise SourceProvenanceError(
            "Git source identity must be lowercase 40-character SHA-1"
        )
    try:
        manifest_relative = str(input_manifest.relative_to(repo_root))
    except ValueError as exc:
        raise SourceProvenanceError("source input manifest escapes repository") from exc
    dockerfile = repo_root / "docker/fem-gpu/Dockerfile"
    justfile = repo_root / "justfile"
    return {
        "source_provenance": {
            "git_commit": git_commit,
            "git_tree": git_tree,
            "dirty": dirty,
            "dirty_patch_sha256": dirty_patch_sha256,
            "source_inputs_sha256": source_inputs_sha256,
            "source_input_manifest": manifest_relative,
        },
        "build_inputs": {
            "justfile_sha256": hashlib.sha256(justfile.read_bytes()).hexdigest(),
            "dockerfile_sha256": hashlib.sha256(dockerfile.read_bytes()).hexdigest(),
            "source_input_manifest_sha256": hashlib.sha256(
                input_manifest.read_bytes()
            ).hexdigest(),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument(
        "--repo-root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--source-input-manifest", type=Path)
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        repo_root = args.repo_root.resolve()
        input_manifest = args.source_input_manifest or repo_root / SOURCE_INPUT_MANIFEST
        payload = collect_source_provenance(
            repo_root, input_manifest, allow_dirty=args.allow_dirty
        )
        encoded = json.dumps(payload, indent=2, sort_keys=True) + "\n"
        if args.output is None:
            print(encoded, end="")
        else:
            args.output.write_text(encoded, encoding="utf-8")
    except (OSError, SourceProvenanceError, ValueError, UnicodeDecodeError) as exc:
        print(f"MANAGED_FEM_RUNTIME_SOURCE_PROVENANCE_ERROR={exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
