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


class SourceIdentityError(RuntimeError):
    pass


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


def _status_records(repo_root: Path) -> list[dict[str, object]]:
    parts = _git(
        repo_root, "status", "--porcelain=v1", "-z", "--untracked-files=all"
    ).split(b"\0")
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


def _capture_once(repo_root: Path) -> dict[str, object]:
    try:
        commit = _git(repo_root, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise SourceIdentityError("cannot decode Git HEAD") from error
    if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit):
        raise SourceIdentityError("Git HEAD is not a full lowercase 40-hex commit identity")
    head_tree_sha256 = _sha256(_git(repo_root, "ls-tree", "-r", "--full-tree", commit))
    status_records = _status_records(repo_root)
    dirty_content = _dirty_content(repo_root, status_records)
    payload = {
        "schema": SCHEMA,
        "head_commit_full": commit,
        "head_tree_sha256": head_tree_sha256,
        "git_status_porcelain_v1": status_records,
        "dirty_path_content": dirty_content,
    }
    return {
        **payload,
        "source_snapshot_dirty": bool(status_records),
        "dirty_content_sha256": _sha256(_canonical_bytes(dirty_content)),
        "source_snapshot_sha256": _sha256(_canonical_bytes(payload)),
    }


def capture(repo_root: Path) -> dict[str, object]:
    repo_root = repo_root.resolve()
    first = _capture_once(repo_root)
    second = _capture_once(repo_root)
    if second != first:
        raise SourceIdentityError("source identity changed while capturing the snapshot")
    return first


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
    archive = subprocess.Popen(
        ("git", "archive", "--format=tar", str(identity["head_commit_full"])),
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
    if capture(repo_root) != identity:
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
    arguments = parser.parse_args(argv)
    try:
        identity = capture(arguments.repo_root)
        if arguments.materialize is not None:
            materialize(
                arguments.repo_root,
                arguments.materialize,
                identity,
                existing_empty=arguments.materialize_existing_empty,
            )
        elif arguments.materialize_existing_empty:
            raise SourceIdentityError(
                "--materialize-existing-empty requires --materialize"
            )
        if arguments.compare is not None:
            expected = json.loads(arguments.compare.read_text(encoding="utf-8"))
            if identity != expected:
                raise SourceIdentityError(
                    "source identity changed during managed FEM runtime build"
                )
            if arguments.verify_materialized is not None:
                verify_materialized(
                    arguments.repo_root.resolve(), arguments.verify_materialized, expected
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
