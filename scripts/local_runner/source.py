"""Capture an immutable, content-addressed source capsule.

The runner receives a capsule rather than a live checkout.  This module is
deliberately read-only with respect to Git: it never stages, commits, checks
out, stashes, or refreshes the index.  A destination is owned by the caller;
it must already exist, be empty, and be outside the checkout.

Only regular files are materialised.  The six Fullmag external-solver
gitlinks are an explicit source-policy exception: their pinned commit is
disclosed in the manifest, but their nested checkout is never followed.  Any
other gitlink and all Git-LFS content are rejected until the worker has an
explicit, tested materialisation implementation for them.  Failing closed is
preferable to silently submitting a source tree with missing files.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import subprocess
import tempfile
from typing import Iterable, Iterator, Mapping, Sequence


SCHEMA = "fullmag.source-capsule.v1"
MANIFEST_FILENAME = "manifest.json"
_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$")
_LFS_POINTER_RE = re.compile(
    rb"\Aversion https://git-lfs\.github\.com/spec/v1\r?\n"
    rb"oid sha256:[0-9a-f]{64}\r?\n"
    rb"size [0-9]+(?:\r?\n|\Z)"
)

# These are source-policy exclusions rather than a generic "ignore anything
# that looks generated" rule.  A tracked path in one of these locations is an
# error: silently dropping it would produce a partial source capsule.
_EXCLUDED_DIRECTORY_NAMES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".fullmag",
        ".fullmag-build",
        ".fullmag-cache",
        ".fullmag-cargo",
        ".fullmag-rustup",
        ".worktrees",
        "node_modules",
        "target",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".venv",
        "venv",
    }
)
# These are repository administration trees.  Fullmag currently carries
# symlinked agent-tooling metadata in some of them; they are deliberately
# omitted and disclosed in ``manifest.json`` rather than followed.  Any other
# symlink/reparse point is rejected fail-closed.
_ADMIN_EXCLUDED_DIRECTORY_NAMES = frozenset(
    {".agents", ".claude", ".codex", ".superpowers", ".worktrees"}
)
# These are reference solver repositories, not Fullmag runner inputs.  Their
# superproject gitlink is retained as a pinned commit disclosure, while the
# nested repository bytes remain outside this capsule.  Do not broaden this
# list without a corresponding source-policy and worker review.
_ALLOWED_EXTERNAL_SOLVER_GITLINKS = frozenset(
    {
        "external_solvers/3",
        "external_solvers/amumax",
        "external_solvers/neuralmag",
        "external_solvers/oommf",
        "external_solvers/plus",
        "external_solvers/tetmag",
    }
)
_EXCLUDED_FILE_NAMES = frozenset(
    {
        ".git-credentials",
        ".netrc",
        ".npmrc",
        ".pypirc",
        "credentials.json",
        "secrets.json",
        "secret.json",
    }
)
# Credential stores are commonly organised under these exact directory names.
# Keep this list narrow: names such as ``credentialing`` or ``secretsauce`` are
# ordinary source directories and must not be excluded by substring matching.
_SECRET_DIRECTORY_NAMES = frozenset(
    {
        ".credential",
        ".credentials",
        ".secret",
        ".secrets",
        "credential",
        "credentials",
        "secret",
        "secrets",
    }
)
_SECRET_FILE_RE = re.compile(
    r"(?:^|[._-])(secret|secrets|token|tokens|credential|credentials)(?:$|[._-])",
    re.IGNORECASE,
)
_SECRET_SUFFIXES = frozenset(
    {
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".jks",
        ".crt",
        ".credential",
        ".credentials",
        ".secret",
        ".secrets",
        ".token",
        ".tokens",
    }
)
# This tracked stylesheet uses ``tokens`` as a design-system identifier, not
# as credential material.  Keep the exception path-specific; the general
# token/credential heuristic remains fail-closed for all other paths.
_SOURCE_IDENTIFIER_PATHS = frozenset({"apps/control-room/src/design/styles/tokens.css"})


class SourceError(RuntimeError):
    """A source capsule cannot be created without violating its contract."""


class _GitError(SourceError):
    pass


def _gitlink_exclusion(relative: str, pinned_commit: str) -> dict[str, str]:
    """Describe an allowlisted gitlink without materialising its checkout."""

    if relative not in _ALLOWED_EXTERNAL_SOLVER_GITLINKS:
        raise SourceError(f"UNSUPPORTED_SUBMODULE: Gitlink at {relative}")
    if not _SHA_RE.fullmatch(pinned_commit):
        raise SourceError(f"invalid pinned gitlink commit at {relative}")
    return {
        "path": relative,
        "type": "gitlink",
        "pinned_commit": pinned_commit,
    }


def _excluded_sort_key(value: object) -> str:
    """Return a stable key for mixed path and gitlink disclosures."""

    if not isinstance(value, (str, Mapping)):
        raise SourceError("invalid source exclusion disclosure")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _normalise_excluded(values: Iterable[object]) -> tuple[object, ...]:
    """Deduplicate and deterministically order manifest exclusions."""

    unique: dict[str, object] = {}
    for value in values:
        if isinstance(value, str):
            unique[_excluded_sort_key(value)] = value
            continue
        if isinstance(value, Mapping):
            path = value.get("path")
            kind = value.get("type")
            pinned = value.get("pinned_commit")
            if (
                not isinstance(path, str)
                or kind != "gitlink"
                or not isinstance(pinned, str)
            ):
                raise SourceError("invalid source exclusion disclosure")
            disclosure = _gitlink_exclusion(path, pinned)
            unique[_excluded_sort_key(disclosure)] = disclosure
            continue
        raise SourceError("invalid source exclusion disclosure")
    return tuple(unique[key] for key in sorted(unique))


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _git(repo: Path, *arguments: str) -> bytes:
    """Run a read-only Git query with optional index locking disabled."""

    environment = os.environ.copy()
    # Git's read-only commands can otherwise refresh the index.  The runner
    # must not mutate the source checkout or its index as a side effect.
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        result = subprocess.run(
            ("git", "-c", "core.filemode=false", *arguments),
            cwd=repo,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except OSError as error:
        raise _GitError(f"cannot run Git for source capture: {error}") from error
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        command = "git " + " ".join(arguments)
        raise _GitError(f"Git query failed ({command}): {detail or 'unknown error'}")
    return result.stdout


def _safe_relative(value: str, label: str) -> str:
    """Validate and normalise a repository-relative path without resolving it."""

    if not value or "\x00" in value:
        raise SourceError(f"unsafe {label} path: {value!r}")
    candidate = Path(value)
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        candidate.is_absolute()
        or bool(candidate.anchor)
        or posix.is_absolute()
        or bool(posix.anchor)
        or windows.is_absolute()
        or bool(windows.anchor)
        or ".." in candidate.parts
        or ".." in posix.parts
        or ".." in windows.parts
    ):
        raise SourceError(f"unsafe {label} path: {value!r}")
    # Git paths use slash separators.  Reject a backslash-containing path
    # rather than allowing platform-specific path traversal interpretation.
    if "\\" in value:
        raise SourceError(f"unsafe {label} path: {value!r}")
    normalised = "/".join(part for part in posix.parts if part not in {"", "."})
    if not normalised:
        raise SourceError(f"unsafe empty {label} path")
    return normalised


def _is_reparse(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(metadata.st_mode):
        return True
    # Python exposes Windows FILE_ATTRIBUTE_REPARSE_POINT through
    # st_file_attributes.  On POSIX this attribute is absent and the value is
    # zero, so the same check remains harmless.
    return bool(getattr(metadata, "st_file_attributes", 0) & 0x400)


def _ensure_no_reparse_ancestors(path: Path, label: str, *, allow_missing: bool) -> None:
    """Reject symlink/junction/reparse components in a caller-owned path."""

    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor) if absolute.anchor else Path()
    # ``Path.parts`` keeps the drive/root separate on Windows.
    for part in absolute.parts:
        if current == Path(part) and current.exists():
            continue
        current = current / part if current != Path() else Path(part)
        if not current.exists():
            if allow_missing:
                continue
            raise SourceError(f"{label} does not exist: {path}")
        if _is_reparse(current):
            raise SourceError(f"{label} traverses a symlink or reparse point: {path}")


def _validated_repo(repo: Path) -> tuple[Path, Path]:
    candidate = Path(repo).expanduser()
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    candidate = Path(os.path.abspath(candidate))
    if not candidate.exists() or not candidate.is_dir() or _is_reparse(candidate):
        raise SourceError(f"repository is not a real directory: {repo}")
    _ensure_no_reparse_ancestors(candidate, "repository", allow_missing=False)
    try:
        root_text = _git(candidate, "rev-parse", "--show-toplevel").decode(
            "utf-8"
        ).strip()
    except UnicodeDecodeError as error:
        raise SourceError("Git checkout root is not valid UTF-8") from error
    if not root_text:
        raise SourceError(f"not a Git checkout: {candidate}")
    root = Path(root_text).resolve()
    if root != candidate.resolve():
        raise SourceError(f"repository must be the Git worktree root: {candidate}")
    superproject = _git(candidate, "rev-parse", "--show-superproject-working-tree").strip()
    if superproject:
        raise SourceError("nested Git submodules are not supported as source roots")
    common_text = _git(candidate, "rev-parse", "--git-common-dir").decode(
        "utf-8"
    ).strip()
    if not common_text:
        raise SourceError("Git common directory is missing")
    common = Path(common_text)
    if not common.is_absolute():
        common = candidate / common
    try:
        common = common.resolve()
    except OSError as error:
        raise SourceError("cannot resolve Git common directory") from error
    return candidate.resolve(), common


def _validated_destination(destination: Path, repo: Path) -> Path:
    candidate = Path(destination).expanduser()
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    candidate = Path(os.path.abspath(candidate))
    if not candidate.exists() or not candidate.is_dir() or _is_reparse(candidate):
        raise SourceError(
            "destination must be an existing, real, caller-allocated directory"
        )
    _ensure_no_reparse_ancestors(candidate, "destination", allow_missing=False)
    resolved_repo = repo.resolve()
    resolved_destination = candidate.resolve()
    if (
        resolved_destination == resolved_repo
        or resolved_destination in resolved_repo.parents
        or resolved_repo in resolved_destination.parents
    ):
        raise SourceError("destination overlaps the repository")
    try:
        children = tuple(candidate.iterdir())
    except OSError as error:
        raise SourceError(f"cannot inspect destination: {candidate}") from error
    if children:
        raise SourceError("destination must be empty")
    return resolved_destination


def _index_records(
    repo: Path,
    excluded: list[object] | None = None,
) -> dict[str, list[tuple[str, str, int]]]:
    records: dict[str, list[tuple[str, str, int]]] = {}
    raw_output = _git(repo, "ls-files", "--stage", "-z")
    for raw in raw_output.split(b"\0"):
        if not raw:
            continue
        header, separator, raw_path = raw.partition(b"\t")
        fields = header.split(b" ")
        if not separator or len(fields) != 3:
            raise SourceError("cannot parse Git index while capturing source")
        try:
            mode = fields[0].decode("ascii")
            object_id = fields[1].decode("ascii")
            stage = int(fields[2])
            relative = _safe_relative(raw_path.decode("utf-8"), "Git index")
        except (UnicodeDecodeError, ValueError) as error:
            raise SourceError("cannot decode Git index while capturing source") from error
        if mode == "160000":
            if excluded is None:
                raise SourceError(f"UNSUPPORTED_SUBMODULE: Gitlink at {relative}")
            if stage != 0:
                raise SourceError(f"unmerged Git index entry at {relative}")
            excluded.append(_gitlink_exclusion(relative, object_id.lower()))
            continue
        if _is_admin_excluded(relative):
            if excluded is not None:
                excluded.append(relative)
            continue
        if mode not in {"100644", "100755", "120000"}:
            raise SourceError(f"unsupported Git index mode {mode} at {relative}")
        records.setdefault(relative, []).append((mode, object_id, stage))
    for relative, entries in records.items():
        entries.sort(key=lambda item: item[2])
        if len(entries) != 1 or entries[0][2] != 0:
            raise SourceError(f"unmerged Git index entry at {relative}")
    return records


def _tree_records(
    repo: Path,
    commit: str,
    excluded: list[object] | None = None,
) -> dict[str, tuple[str, str, str]]:
    """Return ``path -> (mode, type, object id)`` from an immutable tree."""

    records: dict[str, tuple[str, str, str]] = {}
    for raw in _git(repo, "ls-tree", "-r", "-z", "--full-tree", commit).split(b"\0"):
        if not raw:
            continue
        identity, separator, raw_path = raw.partition(b"\t")
        fields = identity.split(b" ")
        if not separator or len(fields) != 3:
            raise SourceError("cannot parse committed Git tree")
        try:
            mode, object_type, object_id = (item.decode("ascii") for item in fields)
            relative = _safe_relative(raw_path.decode("utf-8"), "committed source")
        except UnicodeDecodeError as error:
            raise SourceError("cannot decode committed Git tree") from error
        if mode == "160000" or object_type == "commit":
            if mode == "160000" and object_type == "commit" and excluded is not None:
                excluded.append(_gitlink_exclusion(relative, object_id.lower()))
                continue
            raise SourceError(f"UNSUPPORTED_SUBMODULE: Gitlink at {relative}")
        if _is_admin_excluded(relative):
            if excluded is not None:
                excluded.append(relative)
            continue
        if mode not in {"100644", "100755", "120000"} or object_type != "blob":
            raise SourceError(f"unsupported committed entry at {relative}")
        records[relative] = (mode, object_type, object_id)
    return records


def _policy_reason(relative: str) -> str | None:
    parts = relative.split("/")
    lowered = [part.casefold() for part in parts]
    if relative in _SOURCE_IDENTIFIER_PATHS:
        return None
    if _is_external_solver_gitlink_path(relative):
        return "external solver gitlink is disclosed but not materialised"
    if _is_admin_excluded(relative):
        return "administrative source tree"
    for directory in lowered[:-1]:
        if directory in _SECRET_DIRECTORY_NAMES:
            return f"secret/credential directory {directory!r}"
        if directory in _EXCLUDED_DIRECTORY_NAMES:
            return f"excluded directory {directory!r}"
    basename = lowered[-1]
    if basename in _EXCLUDED_DIRECTORY_NAMES:
        # This is a directory when encountered during a recursive walk.  Keep
        # the same policy for a Git entry whose path ends at that name.
        return f"excluded directory {basename!r}"
    if basename == ".env" or (basename.startswith(".env.") and basename != ".env.example"):
        return "secret environment file"
    if basename in _EXCLUDED_FILE_NAMES:
        return "secret/credential file"
    if basename.endswith(tuple(_SECRET_SUFFIXES)):
        return "secret/key material"
    if _SECRET_FILE_RE.search(Path(basename).stem):
        return "secret/token/credential-like file"
    return None


def _is_admin_excluded(relative: str) -> bool:
    return any(part.casefold() in _ADMIN_EXCLUDED_DIRECTORY_NAMES for part in relative.split("/"))


def _is_external_solver_gitlink_path(relative: str) -> bool:
    return any(
        relative == gitlink or relative.startswith(f"{gitlink}/")
        for gitlink in _ALLOWED_EXTERNAL_SOLVER_GITLINKS
    )


def _reject_policy(relative: str) -> None:
    reason = _policy_reason(relative)
    if reason:
        raise SourceError(f"EXCLUDED_SOURCE: {relative} ({reason})")


def _resolve_source_path(repo: Path, relative: str) -> Path:
    """Resolve parents for containment while keeping the final path lexical."""

    candidate = repo / Path(*relative.split("/"))
    # Do not use a fully resolved final path for the open: a final symlink must
    # be inspected and copied as a link, not followed into another tree.
    # Check the lexical parent first; resolving it before this check would hide
    # an internal symlink/junction behind its contained target path.
    _ensure_no_reparse_ancestors(candidate.parent, "source", allow_missing=True)
    parent = candidate.parent.resolve(strict=False)
    try:
        parent.relative_to(repo.resolve())
    except ValueError as error:
        raise SourceError(f"UNSAFE_SYMLINK: source path escapes repository: {relative}") from error
    _ensure_no_reparse_ancestors(parent, "source", allow_missing=True)
    return parent / candidate.name


def _validate_symlink(repo: Path, relative: str, path: Path) -> str:
    try:
        target = os.readlink(path)
    except OSError as error:
        raise SourceError(f"cannot read source symlink {relative}") from error
    if not target or PurePosixPath(target).is_absolute() or PureWindowsPath(target).is_absolute():
        raise SourceError(f"UNSAFE_SYMLINK: absolute/empty target at {relative}")
    target_path = Path(os.path.normpath(str(path.parent / target)))
    try:
        target_path.resolve(strict=False).relative_to(repo.resolve())
    except ValueError as error:
        raise SourceError(f"UNSAFE_SYMLINK: target escapes repository at {relative}") from error
    # Validate every existing component of the target.  A contained-looking
    # path that traverses an external junction is still an escape.
    _ensure_no_reparse_ancestors(target_path.parent, "source symlink target", allow_missing=True)
    return target


def _stable_file(path: Path, relative: str) -> tuple[str, bytes]:
    """Read a regular source file and detect replacement during the read."""

    try:
        before = path.lstat()
    except FileNotFoundError as error:
        raise SourceError(f"SOURCE_CHANGED: source disappeared: {relative}") from error
    if _is_reparse(path) or not stat.S_ISREG(before.st_mode):
        raise SourceError(f"unsupported source entry type at {relative}")
    try:
        content = path.read_bytes()
    except OSError as error:
        raise SourceError(f"cannot read source file {relative}") from error
    try:
        after = path.lstat()
    except FileNotFoundError as error:
        raise SourceError(f"SOURCE_CHANGED: source disappeared: {relative}") from error
    identity_before = (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    )
    identity_after = (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    )
    if identity_before != identity_after or _is_reparse(path) or not stat.S_ISREG(after.st_mode):
        raise SourceError(f"SOURCE_CHANGED: source changed while reading: {relative}")
    mode = "100755" if before.st_mode & stat.S_IXUSR else "100644"
    return mode, content


def _current_entry(repo: Path, relative: str) -> dict[str, object]:
    path = _resolve_source_path(repo, relative)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return {"path": relative, "type": "deleted", "mode": "000000"}
    if _is_reparse(path):
        if not stat.S_ISLNK(metadata.st_mode):
            raise SourceError(f"UNSAFE_SYMLINK: reparse point at {relative}")
        raise SourceError(f"UNSAFE_SYMLINK: symlink at {relative}")
    if stat.S_ISLNK(metadata.st_mode):
        raise SourceError(f"UNSAFE_SYMLINK: symlink at {relative}")
    if not stat.S_ISREG(metadata.st_mode):
        raise SourceError(f"unsupported source entry type at {relative}")
    mode, content = _stable_file(path, relative)
    if _looks_like_lfs_pointer(content):
        raise SourceError(f"UNSUPPORTED_LFS: Git-LFS pointer at {relative}")
    return {
        "path": relative,
        "type": "file",
        "mode": mode,
        "size": len(content),
        "sha256": _sha256(content),
    }


def _looks_like_lfs_pointer(content: bytes) -> bool:
    return bool(_LFS_POINTER_RE.match(content[:4096]))


def _parse_untracked(repo: Path) -> tuple[str, ...]:
    paths: list[str] = []
    raw = _git(repo, "ls-files", "--others", "--exclude-standard", "-z")
    for value in raw.split(b"\0"):
        if not value:
            continue
        try:
            paths.append(_safe_relative(value.decode("utf-8"), "untracked source"))
        except UnicodeDecodeError as error:
            raise SourceError("cannot decode untracked source path") from error
    return tuple(sorted(set(paths)))


def _expand_explicit_paths(repo: Path, include_untracked: Iterable[str | Path]) -> tuple[str, ...]:
    if isinstance(include_untracked, (str, Path)):
        raw_values: Iterable[str | Path] = (include_untracked,)
    else:
        raw_values = include_untracked
    requested: set[str] = set()
    for raw in raw_values:
        text = os.fspath(raw)
        if not isinstance(text, str):
            text = os.fsdecode(text)
        relative = _safe_relative(text.replace(os.sep, "/"), "included untracked")
        _reject_policy(relative)
        root = _resolve_source_path(repo, relative)
        if not os.path.lexists(root):
            raise SourceError(f"included untracked source is missing: {relative}")
        if root.is_dir() and not root.is_symlink():
            for current, directories, files in os.walk(root, topdown=True, followlinks=False):
                current_path = Path(current)
                for name in list(directories):
                    child = current_path / name
                    child_relative = child.relative_to(repo).as_posix()
                    _reject_policy(child_relative)
                    if _is_reparse(child):
                        # A symlinked directory is itself an entry; validate and
                        # include it rather than walking through its target.
                        directories.remove(name)
                        requested.add(child_relative)
                for name in files:
                    child_relative = (current_path / name).relative_to(repo).as_posix()
                    _reject_policy(child_relative)
                    requested.add(child_relative)
        else:
            requested.add(relative)
    return tuple(sorted(requested))


def _git_check_lfs_attributes(repo: Path, paths: Sequence[str], source: str | None) -> None:
    """Reject paths whose Git attributes require LFS materialisation."""

    if not paths:
        return
    # Feed pathnames through Git's NUL-delimited stdin interface.  Passing a
    # full repository's path list as argv exceeds Windows' command-line limit
    # (WinError 206) before Git can inspect a single attribute.
    arguments = ["check-attr", "-z"]
    if source is None:
        arguments.append("--cached")
    else:
        arguments.append(f"--source={source}")
    arguments.extend(("--stdin", "filter"))
    environment = os.environ.copy()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    result = subprocess.run(
        ("git", *arguments),
        cwd=repo,
        env=environment,
        input=b"\0".join(path.encode("utf-8") for path in paths) + b"\0",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise SourceError(f"cannot inspect Git-LFS attributes: {detail or 'Git error'}")
    fields = result.stdout.split(b"\0")
    if not fields or fields[-1] != b"" or (len(fields) - 1) % 3:
        raise SourceError("cannot inspect Git-LFS attributes: malformed Git output")
    for index in range(0, len(fields) - 2, 3):
        path, attribute, value = fields[index : index + 3]
        if attribute == b"filter" and value == b"lfs":
            try:
                relative = path.decode("utf-8")
            except UnicodeDecodeError:
                relative = "<undecodable path>"
            raise SourceError(f"UNSUPPORTED_LFS: Git-LFS attribute at {relative}")


def _read_git_blobs(repo: Path, records: Mapping[str, tuple[str, str, str]]) -> dict[str, bytes]:
    if not records:
        return {}
    environment = os.environ.copy()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    try:
        process = subprocess.Popen(
            ("git", "cat-file", "--batch"),
            cwd=repo,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise SourceError(f"cannot read committed source blobs: {error}") from error
    assert process.stdin is not None and process.stdout is not None
    result: dict[str, bytes] = {}
    try:
        for relative, (_mode, _kind, object_id) in records.items():
            process.stdin.write((object_id + "\n").encode("ascii"))
            process.stdin.flush()
            header = process.stdout.readline().rstrip(b"\n").split(b" ")
            if len(header) != 3 or header[0].decode("ascii", "replace") != object_id:
                raise SourceError(f"cannot read committed source blob at {relative}")
            if header[1] != b"blob":
                raise SourceError(f"unsupported committed source object at {relative}")
            try:
                size = int(header[2])
            except ValueError as error:
                raise SourceError(f"invalid committed source blob size at {relative}") from error
            content = process.stdout.read(size)
            if len(content) != size or process.stdout.read(1) != b"\n":
                raise SourceError(f"truncated committed source blob at {relative}")
            result[relative] = content
    except BaseException:
        try:
            process.kill()
        except OSError:
            pass
        process.wait()
        try:
            process.stderr.close()
        except OSError:
            pass
        raise
    finally:
        try:
            process.stdin.close()
        except OSError:
            pass
        process.stdout.close()
    assert process.stderr is not None
    detail = process.stderr.read().decode("utf-8", errors="replace").strip()
    process.stderr.close()
    returncode = process.wait()
    if returncode:
        raise SourceError(f"cannot read committed source blobs: {detail or 'Git error'}")
    return result


def _validate_tree_symlinks(entries: Mapping[str, Mapping[str, object]]) -> None:
    for relative, entry in entries.items():
        if entry.get("type") != "symlink":
            continue
        target = entry.get("target")
        if not isinstance(target, str) or not target:
            raise SourceError(f"invalid symlink target at {relative}")
        if PurePosixPath(target).is_absolute() or PureWindowsPath(target).is_absolute():
            raise SourceError(f"UNSAFE_SYMLINK: absolute target at {relative}")
        pending = relative.split("/")[:-1] + target.split("/")
        resolved: list[str] = []
        visited: set[str] = set()
        while pending:
            part = pending.pop(0)
            if part in {"", "."}:
                continue
            if part == "..":
                if not resolved:
                    raise SourceError(f"UNSAFE_SYMLINK: target escapes at {relative}")
                resolved.pop()
                continue
            resolved.append(part)
            current = "/".join(resolved)
            linked = entries.get(current)
            if linked is None or linked.get("type") != "symlink":
                continue
            if current in visited:
                raise SourceError(f"UNSAFE_SYMLINK: symlink loop at {relative}")
            visited.add(current)
            linked_target = linked.get("target")
            if not isinstance(linked_target, str) or not linked_target:
                raise SourceError(f"invalid symlink target at {current}")
            if PurePosixPath(linked_target).is_absolute() or PureWindowsPath(linked_target).is_absolute():
                raise SourceError(f"UNSAFE_SYMLINK: absolute target at {current}")
            resolved.pop()
            pending = linked_target.split("/") + pending


def _state_signature(entries: Sequence[Mapping[str, object]]) -> tuple[dict[str, object], ...]:
    return tuple(dict(entry) for entry in entries)


def _snapshot_state(
    repo: Path,
    *,
    head_commit: str,
    tracked_paths: Sequence[str],
    explicit_paths: Sequence[str],
    base_excluded: Sequence[object] = (),
) -> tuple[dict[str, object], tuple[str, ...]]:
    entries: list[dict[str, object]] = []
    selected = set(explicit_paths)
    for relative in sorted(set(tracked_paths) | selected):
        if _is_admin_excluded(relative):
            continue
        _reject_policy(relative)
        entry = _current_entry(repo, relative)
        entries.append(entry)
    _validate_tree_symlinks({entry["path"]: entry for entry in entries})
    _git_check_lfs_attributes(
        repo,
        tuple(
            entry["path"]
            for entry in entries
            if entry["type"] != "deleted" and entry["path"] in set(tracked_paths)
        ),
        None,
    )
    # The HEAD and index signatures are read separately so a concurrently
    # changing branch/index is detected even when the live file bytes happen
    # to be unchanged.
    index_excluded: list[object] = []
    index_records = _index_records(repo, index_excluded)
    index_signature = _canonical_bytes(
        {
            "records": index_records,
            "excluded": _normalise_excluded(index_excluded),
        }
    )
    current_head = _git(repo, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
    if current_head != head_commit:
        raise SourceError("SOURCE_CHANGED: HEAD changed while capturing source")
    untracked = set(_parse_untracked(repo))
    excluded = _normalise_excluded(
        [
            *base_excluded,
            *index_excluded,
            *(path for path in untracked if path not in selected),
        ]
    )
    return {
        "entries": entries,
        "index_signature": _sha256(index_signature),
        "head_commit": current_head,
        "excluded": excluded,
        "working_tree_dirty": _working_tree_dirty(repo),
    }, tuple(sorted(selected))


def _copy_snapshot_entry(repo: Path, stage: Path, entry: Mapping[str, object]) -> None:
    relative = entry["path"]
    assert isinstance(relative, str)
    if entry.get("type") == "deleted":
        return
    source = _resolve_source_path(repo, relative)
    destination = stage / Path(*relative.split("/"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    if entry.get("type") == "symlink":
        target = _validate_symlink(repo, relative, source)
        if target != entry.get("target"):
            raise SourceError(f"SOURCE_CHANGED: symlink changed while copying: {relative}")
        try:
            destination.symlink_to(target)
        except OSError as error:
            raise SourceError(f"cannot materialize source symlink {relative}") from error
        return
    mode, content = _stable_file(source, relative)
    if mode != entry.get("mode") or _sha256(content) != entry.get("sha256"):
        raise SourceError(f"SOURCE_CHANGED: source changed while copying: {relative}")
    try:
        destination.write_bytes(content)
        destination.chmod(0o755 if mode == "100755" else 0o644)
    except OSError as error:
        raise SourceError(f"cannot materialize source file {relative}") from error


def _copy_commit_entry(stage: Path, entry: Mapping[str, object], content: bytes) -> None:
    relative = entry["path"]
    assert isinstance(relative, str)
    destination = stage / Path(*relative.split("/"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    if entry.get("type") == "symlink":
        target = entry.get("target")
        assert isinstance(target, str)
        try:
            destination.symlink_to(target)
        except OSError as error:
            raise SourceError(f"cannot materialize committed source symlink {relative}") from error
    else:
        try:
            destination.write_bytes(content)
            destination.chmod(0o755 if entry.get("mode") == "100755" else 0o644)
        except OSError as error:
            raise SourceError(f"cannot materialize committed source file {relative}") from error


def _make_read_only(root: Path) -> None:
    directories: list[Path] = []
    for current, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        directories.append(current_path)
        directory_names[:] = [name for name in directory_names if not _is_reparse(current_path / name)]
        for name in file_names:
            path = current_path / name
            if _is_reparse(path):
                continue
            try:
                path.chmod(0o555 if path.stat().st_mode & stat.S_IXUSR else 0o444)
            except OSError:
                # Read-only mode is an attestation aid, not the security
                # boundary; caller-owned ACLs provide the host enforcement.
                pass
    for directory in reversed(directories):
        try:
            directory.chmod(0o555)
        except OSError:
            pass


def _write_manifest(root: Path, manifest: Mapping[str, object]) -> None:
    path = root / MANIFEST_FILENAME
    try:
        path.write_bytes(_canonical_bytes(manifest))
    except OSError as error:
        raise SourceError("cannot write source capsule manifest") from error


def _stage_mismatch_message(
    actual: Mapping[str, Mapping[str, object]],
    expected: Mapping[str, Mapping[str, object]],
    *,
    ignore_mode: bool,
) -> str:
    """Describe the first stage membership mismatch without exposing bytes."""

    actual_paths = set(actual)
    expected_paths = set(expected)
    missing = sorted(expected_paths - actual_paths)
    if missing:
        return f"source capsule missing entry: {missing[0]}"
    extra = sorted(actual_paths - expected_paths)
    if extra:
        return f"source capsule has unexpected entry: {extra[0]}"
    for relative in sorted(expected_paths):
        actual_entry = actual[relative]
        expected_entry = expected[relative]
        keys = sorted(set(actual_entry) | set(expected_entry))
        differing = [
            key
            for key in keys
            if not (ignore_mode and key == "mode")
            and actual_entry.get(key) != expected_entry.get(key)
        ]
        if differing:
            return (
                "source capsule metadata mismatch at "
                f"{relative}: keys={','.join(differing)}"
            )
    return "source capsule differs from its immutable content manifest"


def _verify_stage(stage: Path, entries: Sequence[Mapping[str, object]]) -> None:
    expected = {str(entry["path"]): entry for entry in entries if entry.get("type") != "deleted"}
    actual: dict[str, dict[str, object]] = {}
    for current, directory_names, file_names in os.walk(stage, topdown=True, followlinks=False):
        current_path = Path(current)
        symlink_directories = [name for name in directory_names if (current_path / name).is_symlink()]
        directory_names[:] = [name for name in directory_names if name not in symlink_directories]
        for name in [*file_names, *symlink_directories]:
            path = current_path / name
            relative = path.relative_to(stage).as_posix()
            if _is_reparse(path):
                if not path.is_symlink():
                    raise SourceError(f"source capsule contains an unsafe reparse point: {relative}")
                target = os.readlink(path)
                actual[relative] = {
                    "path": relative,
                    "type": "symlink",
                    "mode": "120000",
                    "size": len(os.fsencode(target)),
                    "sha256": _sha256(os.fsencode(target)),
                    "target": target,
                }
                continue
            if path.is_symlink():
                target = os.readlink(path)
                actual[relative] = {
                    "path": relative,
                    "type": "symlink",
                    "mode": "120000",
                    "size": len(os.fsencode(target)),
                    "sha256": _sha256(os.fsencode(target)),
                    "target": target,
                }
                continue
            if not path.is_file():
                raise SourceError(f"source capsule contains unsupported entry: {relative}")
            content = path.read_bytes()
            mode = "100755" if path.stat().st_mode & stat.S_IXUSR else "100644"
            actual[relative] = {
                "path": relative,
                "type": "file",
                "mode": mode,
                "size": len(content),
                "sha256": _sha256(content),
            }
            if os.name != "nt" and mode != expected.get(relative, {}).get("mode"):
                raise SourceError(f"source capsule mode differs from manifest: {relative}")
    if os.name == "nt":
        # NTFS does not expose Git's POSIX executable bit through ``stat``.
        # The manifest still preserves the committed Git mode, but stage
        # verification on Windows compares immutable bytes and membership
        # without inventing an executable-bit observation.
        comparable_actual = {
            relative: {key: value for key, value in entry.items() if key != "mode"}
            for relative, entry in actual.items()
        }
        comparable_expected = {
            relative: {key: value for key, value in entry.items() if key != "mode"}
            for relative, entry in expected.items()
        }
        if comparable_actual != comparable_expected:
            raise SourceError(
                _stage_mismatch_message(
                    actual,
                    expected,
                    ignore_mode=True,
                )
            )
    elif actual != expected:
        raise SourceError(
            _stage_mismatch_message(
                actual,
                expected,
                ignore_mode=False,
            )
        )
    _validate_tree_symlinks(actual)


def _commit_to_sha(repo: Path, ref: str) -> str:
    if not isinstance(ref, str) or not ref or ref.startswith("-") or "\x00" in ref:
        raise SourceError("commit mode requires a safe, non-empty ref")
    try:
        resolved = _git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise SourceError("resolved commit is not ASCII") from error
    if not _SHA_RE.fullmatch(resolved):
        raise SourceError("Git did not resolve ref to a full commit SHA")
    return resolved.lower()


def _working_tree_dirty(repo: Path) -> bool:
    raw = _git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    return bool(raw.strip(b"\0"))


def _manifest(
    *,
    mode: str,
    repo: Path,
    common: Path,
    requested_ref: str | None,
    resolved_commit: str,
    head_commit: str,
    entries: Sequence[Mapping[str, object]],
    dirty: bool,
    working_tree_dirty: bool,
    included_untracked: Sequence[str],
    deleted: Sequence[str],
    excluded: Sequence[object],
) -> dict[str, object]:
    serialised_entries = [
        dict(entry)
        for entry in sorted(entries, key=lambda item: str(item["path"]))
        if entry.get("type") != "deleted"
    ]
    content_files = [
        {
            key: value
            for key, value in entry.items()
            if key in {"path", "sha256", "size", "mode", "type", "target"}
        }
        for entry in serialised_entries
    ]
    normalised_excluded = list(_normalise_excluded(excluded))
    core: dict[str, object] = {
        "schema_version": SCHEMA,
        "schema": SCHEMA,
        "manifest_filename": MANIFEST_FILENAME,
        "source_mode": mode,
        "repo_root": str(repo),
        "git_common_dir": str(common),
        "requested_ref": requested_ref,
        "resolved_commit": resolved_commit,
        "head_commit": head_commit,
        "dirty": dirty,
        "working_tree_dirty": working_tree_dirty,
        "files": content_files,
        "entries": serialised_entries,
        "deleted": sorted(deleted),
        "included_untracked": sorted(included_untracked),
        "excluded": normalised_excluded,
    }
    # The digest identifies source bytes and tree shape, not this host's
    # checkout path or Git common-directory path.
    digest = _sha256(
        _canonical_bytes(
            {
                "schema_version": SCHEMA,
                "source_mode": mode,
                "resolved_commit": resolved_commit,
                "files": content_files,
                "deleted": sorted(deleted),
                "included_untracked": sorted(included_untracked),
                "excluded": normalised_excluded,
            }
        )
    )
    return {**core, "source_digest": digest, "source_digest_sha256": digest}


def _capture_source_impl(
    repo: Path,
    destination: Path,
    mode: str = "snapshot",
    ref: str | None = None,
    include_untracked: Iterable[str | Path] = (),
) -> dict[str, object]:
    """Capture a source capsule and return its immutable manifest.

    ``snapshot`` captures the current bytes of all tracked paths plus only the
    explicitly named untracked paths.  ``commit`` captures exactly ``ref``;
    the working tree is not consulted for source bytes in that mode.
    """

    if mode not in {"snapshot", "commit"}:
        raise SourceError(f"unsupported source capture mode: {mode!r}")
    if mode == "snapshot" and ref is not None:
        raise SourceError("snapshot mode does not accept ref; choose commit mode")
    repo_root, common = _validated_repo(Path(repo))
    output = _validated_destination(Path(destination), repo_root)
    head = _git(repo_root, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
    if not _SHA_RE.fullmatch(head):
        raise SourceError("Git HEAD is not a full commit SHA")
    if mode == "commit":
        resolved = _commit_to_sha(repo_root, ref or "")
        tree_excluded: list[object] = []
        tree = _tree_records(repo_root, resolved, tree_excluded)
        for relative in tree:
            _reject_policy(relative)
        _git_check_lfs_attributes(repo_root, tuple(tree), resolved)
        blobs = _read_git_blobs(repo_root, tree)
        entries: list[dict[str, object]] = []
        for relative, (git_mode, _object_type, _object_id) in sorted(tree.items()):
            content = blobs[relative]
            if _looks_like_lfs_pointer(content):
                raise SourceError(f"UNSUPPORTED_LFS: Git-LFS pointer at {relative}")
            if git_mode == "120000":
                raise SourceError(f"UNSAFE_SYMLINK: committed symlink at {relative}")
            else:
                entries.append(
                    {
                        "path": relative,
                        "type": "file",
                        "mode": git_mode,
                        "size": len(content),
                        "sha256": _sha256(content),
                    }
                )
        _validate_tree_symlinks({entry["path"]: entry for entry in entries})
        working_dirty = _working_tree_dirty(repo_root)
        manifest = _manifest(
            mode=mode,
            repo=repo_root,
            common=common,
            requested_ref=ref,
            resolved_commit=resolved,
            head_commit=head,
            entries=entries,
            dirty=False,
            working_tree_dirty=working_dirty,
            included_untracked=(),
            deleted=(),
            excluded=tree_excluded,
        )
        content_by_path = blobs
    else:
        tree_excluded = []
        tree = _tree_records(repo_root, head, tree_excluded)
        index_excluded: list[object] = []
        index = _index_records(repo_root, index_excluded)
        explicit = _expand_explicit_paths(repo_root, include_untracked)
        tracked_paths = tuple(sorted(set(index) | set(tree)))
        before, selected = _snapshot_state(
            repo_root,
            head_commit=head,
            tracked_paths=tracked_paths,
            explicit_paths=explicit,
            base_excluded=(*tree_excluded, *index_excluded),
        )
        entries = list(before["entries"])
        _validate_tree_symlinks({entry["path"]: entry for entry in entries})
        stage_parent = output.parent
        stage: Path | None = None
        try:
            stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.capture-", dir=stage_parent))
            tree_stage = stage / "tree"
            tree_stage.mkdir()
            for entry in entries:
                _copy_snapshot_entry(repo_root, tree_stage, entry)
            after, after_selected = _snapshot_state(
                repo_root,
                head_commit=head,
                tracked_paths=tracked_paths,
                explicit_paths=explicit,
                base_excluded=(*tree_excluded, *index_excluded),
            )
            if (
                before["head_commit"] != after["head_commit"]
                or before["index_signature"] != after["index_signature"]
                or _state_signature(before["entries"]) != _state_signature(after["entries"])
                or before["excluded"] != after["excluded"]
                or before["working_tree_dirty"] != after["working_tree_dirty"]
                or selected != after_selected
            ):
                raise SourceError("SOURCE_CHANGED: source changed during capture")
            deleted = [str(entry["path"]) for entry in entries if entry.get("type") == "deleted"]
            manifest = _manifest(
                mode=mode,
                repo=repo_root,
                common=common,
                requested_ref=None,
                resolved_commit=head,
                head_commit=head,
                entries=entries,
                # ``dirty`` identifies a worktree snapshot as a non-commit
                # source capsule.  ``working_tree_dirty`` carries the actual
                # Git dirty state so a clean snapshot is still distinguishable.
                dirty=True,
                # ``working_tree_dirty`` reports Git's actual worktree state;
                # an explicit selection is already represented by
                # ``included_untracked`` and must not make a clean tracked
                # path appear dirty.
                working_tree_dirty=bool(before["working_tree_dirty"]),
                included_untracked=selected,
                deleted=deleted,
                excluded=before["excluded"],
            )
            _verify_stage(tree_stage, entries)
            _write_manifest(stage, manifest)
            # A caller-allocated empty destination is never replaced or
            # removed.  Move only the completed stage contents into it.
            for child in tuple(stage.iterdir()):
                shutil.move(str(child), str(output / child.name))
            _make_read_only(output)
            return manifest
        finally:
            if stage is not None and stage.exists():
                shutil.rmtree(stage, ignore_errors=True)

    # Commit mode reaches this path after the immutable object tree has been
    # fully validated.  It uses the same stage/move path as snapshots but does
    # not inspect or hash live worktree bytes.
    stage: Path | None = None
    try:
        stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.capture-", dir=output.parent))
        tree_stage = stage / "tree"
        tree_stage.mkdir()
        for entry in entries:
            relative = str(entry["path"])
            _copy_commit_entry(tree_stage, entry, content_by_path[relative])
        _verify_stage(tree_stage, entries)
        _write_manifest(stage, manifest)
        for child in tuple(stage.iterdir()):
            shutil.move(str(child), str(output / child.name))
        _make_read_only(output)
        return manifest
    finally:
        if stage is not None and stage.exists():
            shutil.rmtree(stage, ignore_errors=True)


def capture_source(
    repo: Path,
    destination: Path,
    mode: str = "snapshot",
    ref: str | None = None,
    include_untracked: Iterable[str | Path] = (),
) -> dict[str, object]:
    """Capture a source capsule, normalising filesystem failures to SourceError."""

    try:
        return _capture_source_impl(
            repo,
            destination,
            mode=mode,
            ref=ref,
            include_untracked=include_untracked,
        )
    except SourceError:
        raise
    except (OSError, TypeError, ValueError) as error:
        raise SourceError(f"source capture failed: {error}") from error


__all__ = ["MANIFEST_FILENAME", "SCHEMA", "SourceError", "capture_source"]
