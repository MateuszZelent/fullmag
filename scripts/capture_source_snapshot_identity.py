#!/usr/bin/env python3
"""Capture a race-checked Git source identity including exact dirty content."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import posixpath
import stat
import subprocess
import sys
import tempfile
from typing import Sequence


SCHEMA = "fullmag.source-snapshot.v2"

# Keep this list aligned with runtime_source_change_policy.py. These paths may
# change while a managed runtime is being built without changing its binary
# inputs, so the runtime snapshot deliberately leaves them at their committed
# contents.
NON_RUNTIME_PREFIXES = (
    ".agents/",
    ".claude/",
    ".codex/",
    # Codex-Usage is a local tooling checkout, not runtime source.
    "Codex-Usage/",
    ".impl-racetrack/",
    ".worktrees/",
    ".github/",
    # The managed native FEM bundle does not compile the browser application.
    # Keep dirty Control Room edits out of the native source identity so a
    # frontend-only change cannot force (or break) a FEM rebuild.
    "apps/control-room/",
    "docs/",
    "public_docs/",
    "scripts/test_",
)
NON_RUNTIME_FILES = {"AGENTS.md", "CHANGELOG.md", "README.md"}
NON_RUNTIME_EXACT_PATHS = {
    "Codex-Usage",
    ".impl-racetrack",
    # The repository tracks this as an absolute worktree-administration link.
    # It is not a runtime source input and must not be materialized.
    ".worktrees",
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

# Worktree administration is intentionally excluded from the immutable source
# snapshot even when Git records it in the committed tree.  In this repository
# it is an absolute symlink, which is valid metadata but unsafe to materialize.
EXCLUDED_COMMITTED_SOURCE_PATHS = frozenset({".worktrees"})


class SourceIdentityError(RuntimeError):
    pass


def _is_non_runtime_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return (
        normalized in NON_RUNTIME_FILES
        or normalized in NON_RUNTIME_EXACT_PATHS
        or normalized.startswith(NON_RUNTIME_PREFIXES)
        or normalized.endswith(NON_RUNTIME_SUFFIXES)
    )


def _is_excluded_committed_source_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    return normalized in EXCLUDED_COMMITTED_SOURCE_PATHS or any(
        normalized.startswith(f"{excluded}/")
        for excluded in EXCLUDED_COMMITTED_SOURCE_PATHS
    )


def _git(repo_root: Path, *arguments: str) -> bytes:
    try:
        return subprocess.check_output(
            ("git", *arguments), cwd=repo_root, stderr=subprocess.PIPE
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise SourceIdentityError(
            f"cannot resolve Git source identity with {' '.join(arguments)}"
        ) from error


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _normalized_mode(metadata_mode: int) -> str:
    if stat.S_ISREG(metadata_mode):
        return "100755" if metadata_mode & stat.S_IXUSR else "100644"
    if stat.S_ISLNK(metadata_mode):
        return "120000"
    raise SourceIdentityError("source entry is neither a regular file nor a symlink")


def _read_regular_file_stable(path: Path, label: str) -> tuple[os.stat_result, bytes]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            content = stream.read()
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    observed = (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    )
    if observed != (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    ):
        raise SourceIdentityError(f"{label} changed while hashing")
    if not stat.S_ISREG(before.st_mode):
        raise SourceIdentityError(f"{label} is not a regular file")
    return before, content


def _safe_relative_path(relative: str, label: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise SourceIdentityError(f"unsafe {label} path: {relative}")
    return candidate


def _validate_filesystem_symlink_path(root: Path, relative: str) -> None:
    pending = list(_safe_relative_path(relative, "source").parts)
    resolved: list[str] = []
    visited: set[str] = set()
    while pending:
        part = pending.pop(0)
        if part in {"", "."}:
            continue
        if part == "..":
            if not resolved:
                raise SourceIdentityError(
                    f"unsafe source symlink escapes snapshot root: {relative}"
                )
            resolved.pop()
            continue
        resolved.append(part)
        path = root.joinpath(*resolved)
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISLNK(metadata.st_mode):
            continue
        symlink_path = "/".join(resolved)
        if symlink_path in visited:
            raise SourceIdentityError(f"unsafe source symlink loop: {relative}")
        visited.add(symlink_path)
        target = os.readlink(path)
        if Path(target).is_absolute():
            raise SourceIdentityError(
                f"unsafe source symlink has absolute target: {symlink_path}"
            )
        resolved.pop()
        pending = list(Path(target).parts) + pending


def _validate_tree_symlinks(entries: dict[str, dict[str, object]]) -> None:
    def resolve(relative: str) -> None:
        pending = relative.split("/")
        resolved: list[str] = []
        visited: set[str] = set()
        while pending:
            part = pending.pop(0)
            if part in {"", "."}:
                continue
            if part == "..":
                if not resolved:
                    raise SourceIdentityError(
                        f"unsafe source symlink escapes snapshot root: {relative}"
                    )
                resolved.pop()
                continue
            resolved.append(part)
            current = "/".join(resolved)
            entry = entries.get(current)
            if entry is None or entry.get("mode") != "120000":
                continue
            if current in visited:
                raise SourceIdentityError(f"unsafe source symlink loop: {relative}")
            visited.add(current)
            target = entry.get("target")
            if not isinstance(target, str):
                raise SourceIdentityError(f"source symlink has invalid target: {current}")
            if posixpath.isabs(target):
                raise SourceIdentityError(
                    f"unsafe source symlink has absolute target: {current}"
                )
            resolved.pop()
            pending = target.split("/") + pending

    for path, entry in entries.items():
        if entry.get("mode") == "120000":
            resolve(path)


def _committed_entries(repo_root: Path, commit: str) -> dict[str, dict[str, object]]:
    parsed: list[tuple[str, str, str]] = []
    for raw_entry in _git(
        repo_root, "ls-tree", "-r", "-z", "--full-tree", commit
    ).split(b"\0"):
        if not raw_entry:
            continue
        identity, separator, raw_path = raw_entry.partition(b"\t")
        fields = identity.split(b" ")
        if not separator or len(fields) != 3:
            raise SourceIdentityError("cannot parse committed source tree")
        try:
            mode, object_type, object_id = (
                field.decode("ascii") for field in fields
            )
            relative = raw_path.decode("utf-8")
        except UnicodeDecodeError as error:
            raise SourceIdentityError("cannot decode committed source tree") from error
        _safe_relative_path(relative, "committed source")
        if _is_excluded_committed_source_path(relative):
            continue
        if mode == "160000":
            continue
        if object_type != "blob" or mode not in {"100644", "100755", "120000"}:
            raise SourceIdentityError(f"unsupported committed source entry: {relative}")
        parsed.append((relative, mode, object_id))

    process = subprocess.Popen(
        ("git", "cat-file", "--batch"),
        cwd=repo_root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdin is not None and process.stdout is not None
    entries: dict[str, dict[str, object]] = {}
    try:
        for relative, mode, object_id in parsed:
            process.stdin.write(os.fsencode(object_id) + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().rstrip(b"\n").split(b" ")
            if (
                len(header) != 3
                or header[0] != os.fsencode(object_id)
                or header[1] != b"blob"
            ):
                raise SourceIdentityError("cannot read committed source blob")
            try:
                size = int(header[2])
            except ValueError as error:
                raise SourceIdentityError("cannot decode committed source blob") from error
            content = process.stdout.read(size)
            if len(content) != size or process.stdout.read(1) != b"\n":
                raise SourceIdentityError("committed source blob is truncated")
            entry: dict[str, object] = {"mode": mode, "sha256": _sha256(content)}
            if mode == "120000":
                entry["target"] = os.fsdecode(content)
            entries[relative] = entry
    finally:
        process.stdin.close()
        process.stdout.close()
    assert process.stderr is not None
    stderr = process.stderr.read()
    returncode = process.wait()
    if returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise SourceIdentityError(f"cannot read committed source blobs: {detail}")
    return entries


def _snapshot_entries(snapshot_root: Path) -> dict[str, dict[str, object]]:
    if snapshot_root.is_symlink() or not snapshot_root.is_dir():
        raise SourceIdentityError("materialized source snapshot is not a real directory")
    entries: dict[str, dict[str, object]] = {}
    for root, directory_names, file_names in os.walk(snapshot_root, followlinks=False):
        directory = Path(root)
        symlink_directories = [
            name for name in directory_names if (directory / name).is_symlink()
        ]
        directory_names[:] = [
            name for name in directory_names if name not in symlink_directories
        ]
        for name in [*file_names, *symlink_directories]:
            path = directory / name
            relative = path.relative_to(snapshot_root).as_posix()
            metadata = path.lstat()
            mode = _normalized_mode(metadata.st_mode)
            if mode == "120000":
                target = os.readlink(path)
                content = os.fsencode(target)
                entries[relative] = {
                    "mode": mode,
                    "sha256": _sha256(content),
                    "target": target,
                }
            else:
                observed, content = _read_regular_file_stable(
                    path, f"materialized source entry {relative}"
                )
                entries[relative] = {
                    "mode": _normalized_mode(observed.st_mode),
                    "sha256": _sha256(content),
                }
    _validate_tree_symlinks(entries)
    return entries


def _parse_status_records(parts: bytes) -> list[dict[str, object]]:
    parts = parts.split(b"\0")
    records: list[dict[str, object]] = []
    index = 0
    try:
        while index < len(parts) and parts[index]:
            entry = parts[index]
            index += 1
            if len(entry) < 4 or entry[2:3] != b" ":
                raise SourceIdentityError("cannot parse canonical Git status entry")
            status_value = entry[:2].decode("ascii")
            paths = [entry[3:].decode("utf-8")]
            if status_value[0] in "RC" or status_value[1] in "RC":
                if index >= len(parts) or not parts[index]:
                    raise SourceIdentityError("cannot parse canonical Git rename status")
                paths.append(parts[index].decode("utf-8"))
                index += 1
            records.append({"status": status_value, "paths": paths})
    except UnicodeDecodeError as error:
        raise SourceIdentityError("cannot decode canonical Git status") from error
    return records


def _runtime_status_pathspecs(repo_root: Path) -> tuple[str, ...]:
    """Return pathspecs that cover native runtime inputs without docs/UI trees.

    The managed native runtime does not consume the Control Room, documentation,
    or test-only script trees.  Supplying positive top-level pathspecs lets Git
    prune those trees before it walks the worktree, which is important on the
    shared CIFS checkout where a full untracked scan can take minutes.
    """
    top_level = _git(repo_root, "ls-tree", "--name-only", "HEAD").splitlines()
    pathspecs: list[str] = []
    for raw_path in top_level:
        try:
            path = raw_path.decode("utf-8")
        except UnicodeDecodeError as error:
            raise SourceIdentityError("cannot decode Git top-level path") from error
        if _is_non_runtime_path(path):
            continue
        pathspecs.append(path)
    if not pathspecs:
        raise SourceIdentityError("cannot construct runtime source pathspecs")
    # Keep positive roots broad enough to catch new runtime files while pruning
    # known non-runtime subtrees from mixed roots.
    exclusions = (
        ":(exclude).agents/**",
        ":(exclude).codex/**",
        ":(exclude).github/**",
        ":(exclude)apps/control-room/**",
        ":(exclude)docs/**",
        ":(exclude)public_docs/**",
        ":(exclude)scripts/test_*",
        ":(exclude)scripts/test_*/**",
        ":(exclude)**/*.md",
        ":(exclude)**/*.rst",
        ":(exclude)**/*.source-map.json",
    )
    # The wildcard is needed for a newly-created runtime file at repository
    # root; committed top-level entries alone cannot name it.
    return tuple([*pathspecs, ":(top)*", *exclusions])


def _untracked_runtime_records(repo_root: Path) -> list[dict[str, object]]:
    raw_paths = _git(
        repo_root,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        *_runtime_status_pathspecs(repo_root),
    )
    records: list[dict[str, object]] = []
    for raw_path in raw_paths.split(b"\0"):
        if not raw_path:
            continue
        try:
            relative = raw_path.decode("utf-8")
        except UnicodeDecodeError as error:
            raise SourceIdentityError("cannot decode untracked runtime path") from error
        records.append({"status": "??", "paths": [relative]})
    return records


def _status_records(
    repo_root: Path, *, ignore_non_runtime_dirty: bool = False
) -> list[dict[str, object]]:
    if not ignore_non_runtime_dirty:
        return _parse_status_records(
            _git(
                repo_root,
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            )
        )

    # Ask status only for tracked changes.  Untracked files are collected via
    # the pruned runtime pathspec scan below; this avoids the pathological full
    # worktree walk while preserving exact dirty-content capture.
    tracked = _parse_status_records(
        _git(
            repo_root,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=no",
            "--",
            *_runtime_status_pathspecs(repo_root),
        )
    )
    return [*tracked, *_untracked_runtime_records(repo_root)]


def _gitlink_paths(repo_root: Path) -> set[str]:
    paths: set[str] = set()
    for raw_entry in _git(repo_root, "ls-files", "--stage", "-z").split(b"\0"):
        if not raw_entry:
            continue
        identity, separator, raw_path = raw_entry.partition(b"\t")
        fields = identity.split(b" ")
        if not separator or len(fields) != 3:
            raise SourceIdentityError("cannot parse Git index entry while resolving gitlinks")
        if fields[0] == b"160000":
            try:
                paths.add(raw_path.decode("utf-8"))
            except UnicodeDecodeError as error:
                raise SourceIdentityError("cannot decode Git gitlink path") from error
    return paths


def _is_gitlink_path(relative: str, gitlink_paths: set[str]) -> bool:
    return any(
        relative == gitlink or relative.startswith(f"{gitlink}/")
        for gitlink in gitlink_paths
    )


def _index_entries(repo_root: Path, dirty_paths: set[str]) -> dict[str, list[dict[str, object]]]:
    result = {path: [] for path in dirty_paths}
    raw_to_path = {os.fsencode(path): path for path in dirty_paths}
    try:
        for raw_entry in _git(repo_root, "ls-files", "--stage", "-z").split(b"\0"):
            if not raw_entry:
                continue
            identity, separator, raw_path = raw_entry.partition(b"\t")
            relative = raw_to_path.get(raw_path)
            if relative is None:
                continue
            fields = identity.split(b" ")
            if not separator or len(fields) != 3:
                raise SourceIdentityError("cannot parse canonical Git index entry")
            mode, object_id, stage_value = (field.decode("ascii") for field in fields)
            result[relative].append(
                {"mode": mode, "object_id": object_id, "stage": int(stage_value)}
            )
    except (UnicodeDecodeError, ValueError) as error:
        raise SourceIdentityError("cannot decode canonical Git index") from error
    for entries in result.values():
        entries.sort(key=lambda item: (item["stage"], item["mode"], item["object_id"]))
    return result


def _dirty_content(repo_root: Path, records: Sequence[dict[str, object]]) -> list[dict[str, object]]:
    dirty_paths = {path for record in records for path in record["paths"]}
    for relative in sorted(dirty_paths):
        _validate_filesystem_symlink_path(repo_root, relative)
    index_entries = _index_entries(repo_root, dirty_paths)
    identities: list[dict[str, object]] = []
    for relative in sorted(dirty_paths):
        candidate = _safe_relative_path(relative, "dirty source")
        path = repo_root / candidate
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            identities.append(
                {
                    "path": relative,
                    "kind": "missing",
                    "mode": "000000",
                    "git_index_entries": index_entries[relative],
                }
            )
            continue
        if stat.S_ISREG(metadata.st_mode):
            metadata, content = _read_regular_file_stable(
                path, f"dirty source {relative}"
            )
            kind = "regular_file"
        elif stat.S_ISLNK(metadata.st_mode):
            content = os.fsencode(os.readlink(path))
            kind = "symlink_target"
        else:
            raise SourceIdentityError(f"unsupported dirty source type: {relative}")
        identities.append(
            {
                "path": relative,
                "kind": kind,
                "mode": _normalized_mode(metadata.st_mode),
                "sha256": _sha256(content),
                "git_index_entries": index_entries[relative],
            }
        )
    return identities


def _qualification_input_content(
    repo_root: Path, paths: Sequence[str]
) -> list[dict[str, object]]:
    """Hash explicit non-runtime inputs that still govern qualification.

    Test fixtures are intentionally excluded from the native runtime dirty
    scan, but a qualification recipe consumes them after the build.  Binding
    their stable bytes into the source identity closes that race without
    pretending that the fixture is compiled native code.
    """

    identities: list[dict[str, object]] = []
    for relative in sorted(set(paths)):
        candidate = _safe_relative_path(relative, "qualification input")
        _validate_filesystem_symlink_path(repo_root, relative)
        path = repo_root / candidate
        try:
            metadata, content = _read_regular_file_stable(
                path, f"qualification input {relative}"
            )
        except FileNotFoundError as error:
            raise SourceIdentityError(
                f"qualification input is missing: {relative}"
            ) from error
        identities.append(
            {
                "path": relative,
                "mode": _normalized_mode(metadata.st_mode),
                "sha256": _sha256(content),
            }
        )
    return identities


def _capture_once(
    repo_root: Path,
    *,
    ignore_non_runtime_dirty: bool = False,
    qualification_inputs: Sequence[str] = (),
) -> dict[str, object]:
    try:
        commit = _git(repo_root, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise SourceIdentityError("cannot decode Git HEAD") from error
    if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit):
        raise SourceIdentityError("Git HEAD is not a full lowercase 40-hex commit identity")
    head_tree_sha256 = _sha256(_git(repo_root, "ls-tree", "-r", "--full-tree", commit))
    gitlink_paths = _gitlink_paths(repo_root)
    status_records = [
        record
        for record in _status_records(
            repo_root, ignore_non_runtime_dirty=ignore_non_runtime_dirty
        )
        if not any(_is_gitlink_path(path, gitlink_paths) for path in record["paths"])
    ]
    if ignore_non_runtime_dirty:
        status_records = [
            record
            for record in status_records
            if any(not _is_non_runtime_path(path) for path in record["paths"])
        ]
    dirty_content = _dirty_content(repo_root, status_records)
    payload: dict[str, object] = {
        "schema": SCHEMA,
        "head_commit_full": commit,
        "head_tree_sha256": head_tree_sha256,
        "git_status_porcelain_v1": status_records,
        "dirty_path_content": dirty_content,
    }
    explicit_inputs = _qualification_input_content(repo_root, qualification_inputs)
    if explicit_inputs:
        payload["qualification_inputs"] = explicit_inputs
    if ignore_non_runtime_dirty:
        payload["ignored_non_runtime_dirty"] = True
    return {
        **payload,
        "source_snapshot_dirty": bool(status_records),
        "dirty_content_sha256": _sha256(_canonical_bytes(dirty_content)),
        "source_snapshot_sha256": _sha256(_canonical_bytes(payload)),
    }


def capture(
    repo_root: Path,
    *,
    ignore_non_runtime_dirty: bool = False,
    qualification_inputs: Sequence[str] = (),
) -> dict[str, object]:
    repo_root = repo_root.resolve()
    first = _capture_once(
        repo_root,
        ignore_non_runtime_dirty=ignore_non_runtime_dirty,
        qualification_inputs=qualification_inputs,
    )
    second = _capture_once(
        repo_root,
        ignore_non_runtime_dirty=ignore_non_runtime_dirty,
        qualification_inputs=qualification_inputs,
    )
    if second != first:
        raise SourceIdentityError("source identity changed while capturing the snapshot")
    return first


def _qualification_input_paths(identity: dict[str, object]) -> tuple[str, ...]:
    raw = identity.get("qualification_inputs", [])
    if not isinstance(raw, list):
        raise SourceIdentityError("source identity has invalid qualification inputs")
    paths: list[str] = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise SourceIdentityError("source identity has invalid qualification input")
        paths.append(item["path"])
    return tuple(paths)


def _remove_snapshot_entry(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    if path.is_dir():
        for child in path.iterdir():
            _remove_snapshot_entry(child)
        path.rmdir()


def _copy_dirty_entry(
    repo_root: Path,
    snapshot_root: Path,
    identity: dict[str, object],
) -> None:
    relative = identity["path"]
    if not isinstance(relative, str):
        raise SourceIdentityError("dirty source identity has an invalid path")
    candidate = _safe_relative_path(relative, "dirty source")
    _validate_filesystem_symlink_path(repo_root, relative)
    source = repo_root / candidate
    destination = snapshot_root / candidate
    if os.path.lexists(destination):
        _remove_snapshot_entry(destination)
    if identity.get("kind") == "missing":
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        metadata = source.lstat()
    except FileNotFoundError as error:
        raise SourceIdentityError(
            f"dirty source disappeared while materializing: {relative}"
        ) from error
    observed_mode = _normalized_mode(metadata.st_mode)
    if observed_mode != identity.get("mode"):
        raise SourceIdentityError(
            f"dirty source mode changed while materializing: {relative}"
        )
    if stat.S_ISREG(metadata.st_mode):
        _, content = _read_regular_file_stable(
            source, f"dirty source {relative} while materializing"
        )
        destination.write_bytes(content)
        destination.chmod(0o755 if observed_mode == "100755" else 0o644)
    elif stat.S_ISLNK(metadata.st_mode):
        target = os.readlink(source)
        destination.symlink_to(target)
        content = os.fsencode(target)
    else:
        raise SourceIdentityError(f"unsupported dirty source type: {relative}")
    if _sha256(content) != identity.get("sha256"):
        raise SourceIdentityError(
            f"dirty source content changed while materializing: {relative}"
        )


def _make_snapshot_read_only(snapshot_root: Path) -> None:
    directories: list[Path] = []
    for root, directory_names, file_names in os.walk(snapshot_root):
        directory = Path(root)
        directories.append(directory)
        for name in file_names:
            path = directory / name
            if path.is_symlink():
                continue
            mode = _normalized_mode(path.lstat().st_mode)
            path.chmod(0o555 if mode == "100755" else 0o444)
        directory_names[:] = [
            name for name in directory_names if not (directory / name).is_symlink()
        ]
    for directory in reversed(directories):
        directory.chmod(0o555)


def materialize(
    repo_root: Path,
    snapshot_root: Path,
    identity: dict[str, object],
    *,
    existing_empty: bool = False,
    ignore_non_runtime_dirty: bool = False,
) -> None:
    repo_root = repo_root.resolve()
    snapshot_root = snapshot_root.absolute()
    if os.path.lexists(snapshot_root):
        if (
            not existing_empty
            or snapshot_root.is_symlink()
            or not snapshot_root.is_dir()
            or any(snapshot_root.iterdir())
        ):
            raise SourceIdentityError(
                f"source snapshot destination already exists: {snapshot_root}"
            )
    commit = identity.get("head_commit_full")
    if not isinstance(commit, str):
        raise SourceIdentityError("source identity has invalid committed source")
    committed_entries = _committed_entries(repo_root, commit)
    _validate_tree_symlinks(committed_entries)
    if not snapshot_root.exists():
        snapshot_root.mkdir(parents=True)
    archive_command = (
        "git",
        "archive",
        "--format=tar",
        str(identity["head_commit_full"]),
        "--",
        ".",
        *(f":(exclude){path}" for path in sorted(EXCLUDED_COMMITTED_SOURCE_PATHS)),
    )
    archive = subprocess.Popen(
        archive_command,
        cwd=repo_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert archive.stdout is not None
    extracted = subprocess.run(
        ("tar", "-xf", "-", "-C", str(snapshot_root)),
        stdin=archive.stdout,
        capture_output=True,
        check=False,
    )
    archive.stdout.close()
    assert archive.stderr is not None
    archive_stderr = archive.stderr.read()
    archive.returncode = archive.wait()
    if archive.returncode != 0 or extracted.returncode != 0:
        detail = archive_stderr.decode("utf-8", errors="replace").strip()
        detail = detail or extracted.stderr.decode("utf-8", errors="replace").strip()
        raise SourceIdentityError(f"cannot materialize committed source tree: {detail}")
    _snapshot_entries(snapshot_root)
    dirty_content = identity.get("dirty_path_content")
    if not isinstance(dirty_content, list):
        raise SourceIdentityError("source identity has invalid dirty content")
    for entry in dirty_content:
        if not isinstance(entry, dict):
            raise SourceIdentityError("source identity has an invalid dirty entry")
        _copy_dirty_entry(repo_root, snapshot_root, entry)
    if capture(
        repo_root,
        ignore_non_runtime_dirty=ignore_non_runtime_dirty,
        qualification_inputs=_qualification_input_paths(identity),
    ) != identity:
        raise SourceIdentityError("source identity changed while materializing the snapshot")
    verify_materialized(repo_root, snapshot_root, identity)
    _make_snapshot_read_only(snapshot_root)


def verify_materialized(
    repo_root: Path,
    snapshot_root: Path,
    identity: dict[str, object],
) -> None:
    commit = identity.get("head_commit_full")
    dirty_content = identity.get("dirty_path_content")
    if not isinstance(commit, str) or not isinstance(dirty_content, list):
        raise SourceIdentityError("source identity cannot describe a materialized snapshot")
    expected = _committed_entries(repo_root, commit)
    for item in dirty_content:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise SourceIdentityError("source identity has an invalid dirty entry")
        relative = item["path"]
        if item.get("kind") == "missing":
            expected.pop(relative, None)
            continue
        mode = item.get("mode")
        digest = item.get("sha256")
        if mode not in {"100644", "100755", "120000"} or not isinstance(
            digest, str
        ):
            raise SourceIdentityError("source identity has an invalid dirty entry")
        entry: dict[str, object] = {"mode": mode, "sha256": digest}
        if mode == "120000":
            source = repo_root / _safe_relative_path(relative, "dirty source")
            _validate_filesystem_symlink_path(repo_root, relative)
            target = os.readlink(source)
            if _sha256(os.fsencode(target)) != digest:
                raise SourceIdentityError(
                    f"dirty source content changed while verifying: {relative}"
                )
            entry["target"] = target
        expected[relative] = entry
    _validate_tree_symlinks(expected)
    if _snapshot_entries(snapshot_root) != expected:
        raise SourceIdentityError(
            "materialized source snapshot differs from captured identity"
        )


def verify_materialized_snapshot(
    repo_root: Path,
    snapshot_root: Path,
    identity: dict[str, object],
) -> None:
    """Verify a snapshot using only the captured identity and Git objects.

    This intentionally does not inspect dirty files in the live worktree. The
    worktree is allowed to change after a managed build has captured its
    immutable source snapshot.
    """
    commit = identity.get("head_commit_full")
    dirty_content = identity.get("dirty_path_content")
    if not isinstance(commit, str) or not isinstance(dirty_content, list):
        raise SourceIdentityError("source identity cannot describe a materialized snapshot")
    actual = _snapshot_entries(snapshot_root)
    expected = _committed_entries(repo_root, commit)
    for item in dirty_content:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise SourceIdentityError("source identity has an invalid dirty entry")
        relative = item["path"]
        if item.get("kind") == "missing":
            expected.pop(relative, None)
            continue
        mode = item.get("mode")
        digest = item.get("sha256")
        if mode not in {"100644", "100755", "120000"} or not isinstance(
            digest, str
        ):
            raise SourceIdentityError("source identity has an invalid dirty entry")
        entry: dict[str, object] = {"mode": mode, "sha256": digest}
        if mode == "120000":
            snapshot_entry = actual.get(relative)
            if (
                not isinstance(snapshot_entry, dict)
                or snapshot_entry.get("mode") != mode
                or snapshot_entry.get("sha256") != digest
                or not isinstance(snapshot_entry.get("target"), str)
            ):
                raise SourceIdentityError(
                    f"materialized dirty symlink differs from captured identity: {relative}"
                )
            entry["target"] = snapshot_entry["target"]
        expected[relative] = entry
    _validate_tree_symlinks(expected)
    if actual != expected:
        raise SourceIdentityError(
            "materialized source snapshot differs from captured identity"
        )


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(_canonical_bytes(payload))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path)
    parser.add_argument("--compare", type=Path)
    parser.add_argument("--materialize", type=Path)
    parser.add_argument("--materialize-existing-empty", action="store_true")
    parser.add_argument("--verify-materialized", type=Path)
    parser.add_argument(
        "--allow-source-drift",
        action="store_true",
        help="warn instead of failing when the live worktree differs from --compare",
    )
    parser.add_argument(
        "--ignore-non-runtime-dirty",
        action="store_true",
        help="exclude documentation, CI, tests, and packaging-only dirty paths",
    )
    parser.add_argument(
        "--qualification-input",
        action="append",
        default=[],
        help="bind an explicit non-runtime qualification input by relative path",
    )
    parser.add_argument(
        "--verify-materialized-snapshot",
        type=Path,
        help="verify a materialized snapshot without reading the live worktree",
    )
    arguments = parser.parse_args(argv)
    try:
        if arguments.verify_materialized_snapshot is not None:
            if arguments.compare is None:
                raise SourceIdentityError(
                    "--verify-materialized-snapshot requires --compare"
                )
            if arguments.materialize is not None or arguments.output is not None:
                raise SourceIdentityError(
                    "--verify-materialized-snapshot cannot be combined with --output or --materialize"
                )
            expected = json.loads(arguments.compare.read_text(encoding="utf-8"))
            verify_materialized_snapshot(
                arguments.repo_root.resolve(),
                arguments.verify_materialized_snapshot,
                expected,
            )
            return 0
        identity = capture(
            arguments.repo_root,
            ignore_non_runtime_dirty=arguments.ignore_non_runtime_dirty,
            qualification_inputs=arguments.qualification_input,
        )
        if arguments.materialize is not None:
            materialize(
                arguments.repo_root,
                arguments.materialize,
                identity,
                existing_empty=arguments.materialize_existing_empty,
                ignore_non_runtime_dirty=arguments.ignore_non_runtime_dirty,
            )
        elif arguments.materialize_existing_empty:
            raise SourceIdentityError(
                "--materialize-existing-empty requires --materialize"
            )
        if arguments.compare is not None:
            expected = json.loads(arguments.compare.read_text(encoding="utf-8"))
            identity_matches = identity == expected
            if not identity_matches:
                message = "source identity changed during managed FEM runtime build"
                if arguments.allow_source_drift:
                    print(f"SOURCE_IDENTITY_WARNING={message}", file=sys.stderr)
                else:
                    raise SourceIdentityError(message)
            if arguments.verify_materialized is not None:
                if identity_matches:
                    verify_materialized(
                        arguments.repo_root.resolve(), arguments.verify_materialized, expected
                    )
                elif arguments.allow_source_drift:
                    print(
                        "SOURCE_IDENTITY_WARNING=skipping live-worktree snapshot verification after source drift",
                        file=sys.stderr,
                    )
        elif arguments.verify_materialized is not None:
            raise SourceIdentityError("--verify-materialized requires --compare")
        if arguments.output is not None:
            _write_json(arguments.output, identity)
        elif arguments.compare is None:
            print(_canonical_bytes(identity).decode("utf-8"), end="")
    except (OSError, json.JSONDecodeError, SourceIdentityError) as error:
        print(f"SOURCE_IDENTITY_ERROR={error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
