"""Verify direct-Compose source inputs and capture mounted dev source.

The archive and external manifest are both untrusted inputs at this boundary.
Only regular files named by the verified source manifest are written.  The
destination is created in a temporary sibling and renamed only after the
archive digest, manifest, member set, and every file digest have passed.
Development starts use :func:`capture_live_source_manifest` to inspect the
readonly checkout and mounted Git common directory without executing any
checkout-owned host helper.
"""

from __future__ import annotations

import argparse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import selectors
import shutil
import stat
import sys
import tarfile
import tempfile
import subprocess
import threading
import time
from typing import Any, BinaryIO, Mapping
import uuid


ARCHIVE_MANIFEST_SCHEMA = "fullmag.docker-backend-source.v1"
SOURCE_MANIFEST_SCHEMA = "fullmag.source-capsule.v1"
EMBEDDED_MANIFEST_FILENAME = "backend-source-manifest.json"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024 * 1024
MAX_MEMBERS = 300_000
# A full readonly inventory can take longer than two minutes over the Windows
# bind mount. Keep this as a per-child Git budget; runtime and lease deadlines
# are independent.
LIVE_GIT_TIMEOUT_SECONDS = 300
# Editors and formatters may save while a start captures the checkout.
LIVE_CAPTURE_ATTEMPTS = 3
LIVE_CAPTURE_RETRY_SECONDS = 2.0
LIVE_AUTO_UNTRACKED_MAX_BYTES = 16 * 1024 * 1024
LIVE_GIT_CHUNK_BYTES = 64 * 1024
LIVE_GIT_STDERR_BYTES = 64 * 1024
LIVE_GIT_HEADER_BYTES = 4 * 1024
LIVE_GIT_MARKER_BYTES = 4 * 1024
LIVE_HASH_WORKERS = 8
LIVE_HASH_CHUNK_BYTES = 1024 * 1024
CAPTURE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
LIVE_MANIFEST_SCHEMA = "fullmag.docker-backend-live-source.v1"
LIVE_SOURCE_MODE = "live-shadow-v1"
LIVE_MANIFEST_DIRNAME = ".fullmag-live-source"
LIVE_MANIFEST_FILENAME = "manifest.json"
LIVE_HASH_CACHE_FILENAME = "hash-cache.json"
LIVE_HASH_CACHE_SCHEMA = "fullmag.docker-backend-live-hash-cache.v1"
LIVE_LFS_POINTER_RE = re.compile(
    rb"\A[vV]ersion https://git-lfs\.github\.com/spec/v1\r?\n"
    rb"oid sha256:[0-9a-f]{64}\r?\n"
    rb"size [0-9]+(?:\r?\n|\Z)"
)
LIVE_ADMIN_EXCLUDED_DIRECTORIES = frozenset(
    {".agents", ".claude", ".codex", ".superpowers", ".worktrees"}
)
LIVE_SOURCE_EXCLUDED_DIRECTORIES = frozenset(
    {
        ".git", ".hg", ".svn", ".fullmag", ".fullmag-build", ".fullmag-cache",
        ".fullmag-cargo", ".fullmag-rustup", "node_modules", "target",
        "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv",
    }
)
LIVE_ALLOWED_GITLINKS = frozenset(
    {
        "external_solvers/3",
        "external_solvers/amumax",
        "external_solvers/neuralmag",
        "external_solvers/oommf",
        "external_solvers/plus",
        "external_solvers/tetmag",
    }
)
LIVE_NON_RUNTIME_PREFIXES = (
    ".fullmag-build/", ".fullmag-cache/", ".fullmag-cargo/", ".fullmag-rustup/",
    ".agents/", ".claude/", ".codex/", "Codex-Usage/", ".impl-racetrack/",
    ".worktrees/", ".github/", "apps/control-room/", "docs/", "public_docs/",
    "scripts/test_", "packages/fullmag-py/tests/",
)
LIVE_NON_RUNTIME_EXACT = frozenset(
    {
        ".fullmag-build", ".fullmag-cache", ".fullmag-cargo", ".fullmag-rustup",
        "Codex-Usage", ".impl-racetrack", ".worktrees", "apps/control-room/next-env.d.ts",
        "justfile", "scripts/export_fem_gpu_runtime.sh",
        "scripts/capture_source_snapshot_identity.py",
        "scripts/lib/managed_fem_image_identity.sh",
        "scripts/prune_managed_fem_runtimes.sh",
        "scripts/public_docs_information_architecture.py",
        "scripts/runtime_source_change_policy.py",
    }
)
LIVE_NON_RUNTIME_SUFFIXES = (".md", ".rst", ".source-map.json")

# Keep this pathspec contract aligned with
# scripts/capture_source_snapshot_identity.py::_runtime_status_pathspecs.
LIVE_RUNTIME_STATUS_EXCLUSIONS = (
    ":(exclude).fullmag-build/**",
    ":(exclude).fullmag-cache/**",
    ":(exclude).fullmag-cargo/**",
    ":(exclude).fullmag-rustup/**",
    ":(exclude)external_solvers/**",
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


class BackendSourceError(RuntimeError):
    """The direct backend source archive is not safe or internally coherent."""


class LiveSourceChanged(BackendSourceError):
    """A live checkout file changed while it was being captured; retry is safe."""


def _canonical_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file_stream(stream: BinaryIO, expected_size: int) -> str:
    digest = hashlib.sha256()
    total = 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        total += len(chunk)
        if total > MAX_ARCHIVE_BYTES:
            raise BackendSourceError("backend source archive exceeds the size limit")
        digest.update(chunk)
    if total != expected_size:
        raise BackendSourceError("backend source archive changed while being read")
    return digest.hexdigest()


def _reject_duplicate_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise BackendSourceError("JSON manifest contains duplicate keys")
        result[key] = value
    return result


def _read_regular_json(path: Path) -> dict[str, Any]:
    descriptor: int | None = None
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0),
        )
        metadata = os.fstat(descriptor)
        path_metadata = path.lstat()
        if (
            not stat.S_ISREG(metadata.st_mode)
            or stat.S_ISLNK(path_metadata.st_mode)
            or getattr(path_metadata, "st_file_attributes", 0) & 0x400
            or metadata.st_nlink != 1
            or metadata.st_size <= 0
            or metadata.st_size > MAX_MANIFEST_BYTES
        ):
            raise BackendSourceError("manifest is not one bounded regular file")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(MAX_MANIFEST_BYTES + 1)
        after = os.fstat(descriptor)
    except (OSError, UnicodeError) as error:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise BackendSourceError(f"cannot read manifest: {path}") from error
    finally:
        try:
            os.close(descriptor)
        except (UnboundLocalError, OSError):
            pass
    if len(raw) != metadata.st_size or (metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns) != (
        after.st_size, after.st_mtime_ns, after.st_ctime_ns
    ):
        raise BackendSourceError("manifest changed while being read")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_pairs)
    except (UnicodeError, ValueError) as error:
        raise BackendSourceError("manifest is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise BackendSourceError("manifest root must be an object")
    return value


def _safe_member_name(value: object) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        raise BackendSourceError("archive member name is invalid")
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or windows.anchor
        or value != posix.as_posix()
        or any(part in {"", ".", ".."} for part in posix.parts)
    ):
        raise BackendSourceError(f"archive member escapes its root: {value!r}")
    return value


def _sha256(value: object, label: str, *, length: int = 64) -> str:
    regex = SHA256_RE if length == 64 else SHA40_RE
    if not isinstance(value, str) or not regex.fullmatch(value):
        raise BackendSourceError(f"{label} is not a lowercase digest")
    return value


def _source_manifest_digest(source_manifest: Mapping[str, Any]) -> str:
    try:
        material = {
            "schema_version": source_manifest["schema_version"],
            "source_mode": source_manifest["source_mode"],
            "resolved_commit": source_manifest["resolved_commit"],
            "files": source_manifest["files"],
            "deleted": source_manifest["deleted"],
            "included_untracked": source_manifest["included_untracked"],
            "excluded": source_manifest["excluded"],
        }
    except KeyError as error:
        raise BackendSourceError(f"source manifest is missing {error.args[0]}") from error
    return _sha256_bytes(_canonical_bytes(material))


def _validate_source_manifest(value: object) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    if not isinstance(value, dict):
        raise BackendSourceError("source_manifest must be an object")
    if value.get("schema") != SOURCE_MANIFEST_SCHEMA or value.get("schema_version") != SOURCE_MANIFEST_SCHEMA:
        raise BackendSourceError("source_manifest schema mismatch")
    if value.get("source_mode") not in {"commit", "snapshot"}:
        raise BackendSourceError("source_manifest source_mode is invalid")
    resolved = _sha256(value.get("resolved_commit"), "source_manifest.resolved_commit", length=40)
    files = value.get("files")
    if not isinstance(files, list):
        raise BackendSourceError("source_manifest.files must be a list")
    checked: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for index, raw in enumerate(files):
        if not isinstance(raw, dict):
            raise BackendSourceError(f"source_manifest.files[{index}] is not an object")
        path = _safe_member_name(raw.get("path"))
        if path in checked:
            raise BackendSourceError(f"duplicate source manifest path: {path}")
        if raw.get("type") != "file" or raw.get("mode") not in {"100644", "100755"}:
            raise BackendSourceError(f"source manifest entry is not regular: {path}")
        size = raw.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0 or size > MAX_FILE_BYTES:
            raise BackendSourceError(f"source manifest file size is invalid: {path}")
        checked[path] = {
            "path": path,
            "type": "file",
            "mode": raw["mode"],
            "size": size,
            "sha256": _sha256(raw.get("sha256"), f"source manifest file {path}"),
        }
        order.append(path)
    if order != sorted(order):
        raise BackendSourceError("source manifest files are not canonically sorted")
    for field in ("deleted", "included_untracked", "excluded"):
        if not isinstance(value.get(field), list):
            raise BackendSourceError(f"source_manifest.{field} must be a list")
    for field in ("deleted", "included_untracked"):
        seen: set[str] = set()
        for item in value[field]:
            path = _safe_member_name(item)
            if path in seen:
                raise BackendSourceError(f"duplicate source manifest {field} path: {path}")
            seen.add(path)
    file_paths = set(checked)
    deleted_paths = set(value["deleted"])
    untracked_paths = set(value["included_untracked"])
    if (
        file_paths & deleted_paths
        or not untracked_paths <= file_paths
        or deleted_paths & untracked_paths
    ):
        raise BackendSourceError("source manifest path classes overlap")
    expected = _source_manifest_digest(value)
    if value.get("source_digest") != expected or value.get("source_digest_sha256") != expected:
        raise BackendSourceError("source_manifest digest does not match its content")
    if value.get("resolved_commit") != resolved:
        raise BackendSourceError("source_manifest commit is not canonical lowercase hex")
    return dict(value), checked


def _validate_native_identity(value: object, resolved_commit: str) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != "fullmag.source-snapshot.v2":
        raise BackendSourceError("native_source_identity schema mismatch")
    if value.get("head_commit_full") != resolved_commit:
        raise BackendSourceError("native identity commit differs from source manifest")
    for field in ("head_tree_sha256", "dirty_content_sha256", "source_snapshot_sha256"):
        _sha256(value.get(field), f"native_source_identity.{field}")
    if type(value.get("source_snapshot_dirty")) is not bool or type(value.get("ignored_non_runtime_dirty")) is not bool:
        raise BackendSourceError("native source dirty flags are invalid")
    if not isinstance(value.get("git_status_porcelain_v1"), list) or not isinstance(value.get("dirty_path_content"), list):
        raise BackendSourceError("native source status fields are invalid")
    return dict(value)


def _live_canonical(value: object) -> bytes:
    return _canonical_bytes(value)


def _live_sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _live_fail(message: str) -> None:
    raise BackendSourceError(message)


def _live_safe_relative(value: str, label: str) -> str:
    if not value or "\x00" in value or "\\" in value:
        _live_fail(f"{label} path is invalid")
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.is_absolute()
        or windows.anchor
        or value != posix.as_posix()
        or any(part in {"", ".", ".."} for part in posix.parts)
    ):
        _live_fail(f"{label} path escapes its root: {value!r}")
    return value


def _live_assert_path(path: Path, label: str, *, directory: bool | None = None) -> None:
    if not path.is_absolute():
        _live_fail(f"{label} must be absolute")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise BackendSourceError(f"cannot inspect {label}") from error
        if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
            _live_fail(f"{label} traverses a link or reparse point")
    if directory is not None:
        try:
            metadata = path.lstat()
        except OSError as error:
            raise BackendSourceError(f"cannot inspect {label}") from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            _live_fail(f"{label} is not a real directory")


def _live_git_query_label(arguments: tuple[str, ...]) -> str:
    """Return a bounded diagnostic label without exposing Git arguments."""
    if not arguments:
        return "git-query"
    command = arguments[0]
    if command == "rev-parse":
        return "rev-parse-head"
    if command == "ls-tree":
        return "ls-tree-head"
    if command == "check-attr":
        return "check-attr-filter"
    if command == "status":
        return "status-runtime"
    if command == "ls-files":
        if "--stage" in arguments:
            return "ls-files-stage"
        if "--others" in arguments:
            return "ls-files-untracked"
        if "-t" in arguments:
            return "ls-files-tags"
    return "git-query"


class _LiveGitProcess:
    """Run one bounded Git child with one deadline for every pipe operation."""

    def __init__(
        self,
        command: tuple[str, ...],
        environment: Mapping[str, str],
        *,
        query_label: str = "git-query",
    ):
        self.query_label = query_label
        self.query_started = time.monotonic()
        self.query_logged = False
        self.stdout_bytes = 0
        self.stderr_bytes = 0
        self.returncode: int | None = None
        print(
            f"fullmag-live-source git_query={self.query_label} phase=start",
            file=sys.stderr,
            flush=True,
        )
        try:
            self.process = subprocess.Popen(
                command,
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as error:
            self._log_query("failure", error_type=type(error).__name__)
            raise BackendSourceError(f"cannot run read-only Git source query: {error}") from error
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        assert self.process.stderr is not None
        self.stdin = self.process.stdin
        self.stdout = self.process.stdout
        self.stderr = self.process.stderr
        self.selector = selectors.DefaultSelector()
        self.deadline = time.monotonic() + LIVE_GIT_TIMEOUT_SECONDS
        self.stdout_buffer = bytearray()
        self.stderr_buffer = bytearray()
        self.stdout_open = True
        self.stderr_open = True
        self.stdin_open = True
        for stream, kind in (
            (self.stdout, "stdout"),
            (self.stderr, "stderr"),
        ):
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, kind)
        os.set_blocking(self.stdin.fileno(), False)

    def _close(self, stream, *, attribute: str) -> None:
        try:
            self.selector.unregister(stream)
        except (KeyError, ValueError):
            pass
        try:
            stream.close()
        except OSError:
            pass
        setattr(self, attribute, False)

    def _close_stdin(self) -> None:
        if self.stdin_open:
            self._close(self.stdin, attribute="stdin_open")

    def _terminate(self) -> None:
        if self.process.poll() is None:
            try:
                self.process.kill()
            except OSError:
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

    def _timeout(self) -> BackendSourceError:
        return BackendSourceError(
            f"Git source query {self.query_label} timed out after {LIVE_GIT_TIMEOUT_SECONDS} seconds"
        )

    def _log_query(self, phase: str, *, error_type: str | None = None) -> None:
        if self.query_logged:
            return
        elapsed_ms = int((time.monotonic() - self.query_started) * 1000)
        fields = (
            f"fullmag-live-source git_query={self.query_label} phase={phase} "
            f"elapsed_ms={elapsed_ms} stdout_bytes={self.stdout_bytes} "
            f"stderr_bytes={self.stderr_bytes}"
        )
        if self.returncode is not None:
            fields += f" returncode={self.returncode}"
        if error_type is not None:
            fields += f" error_type={error_type}"
        print(fields, file=sys.stderr, flush=True)
        self.query_logged = True

    def _read(self, stream, target: bytearray, limit: int, label: str, *, extra: int = 1) -> None:
        capacity = limit + extra
        if len(target) > capacity:
            raise BackendSourceError(f"Git source query {label} exceeded its size bound")
        count = min(LIVE_GIT_CHUNK_BYTES, max(1, capacity - len(target)))
        try:
            chunk = os.read(stream.fileno(), count)
        except BlockingIOError:
            return
        except OSError as error:
            raise BackendSourceError(f"cannot read Git {label}: {error}") from error
        if not chunk:
            if stream is self.stdout:
                self._close(stream, attribute="stdout_open")
            else:
                self._close(stream, attribute="stderr_open")
            return
        if stream is self.stdout:
            self.stdout_bytes += len(chunk)
        else:
            self.stderr_bytes += len(chunk)
        if len(target) + len(chunk) > capacity:
            raise BackendSourceError(f"Git source query {label} exceeded its size bound")
        target.extend(chunk)

    def _pump(
        self,
        *,
        stdout_limit: int,
        read_stdout: bool = True,
        read_stdin: bool = False,
        stdin_data: bytes | None = None,
        stdin_offset: int = 0,
        stdout_extra: int = 1,
    ) -> int:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise self._timeout()
        if read_stdin and self.stdin_open:
            try:
                self.selector.register(self.stdin, selectors.EVENT_WRITE, "stdin")
            except KeyError:
                pass
        try:
            ready = self.selector.select(remaining)
        finally:
            if read_stdin and self.stdin_open:
                try:
                    self.selector.unregister(self.stdin)
                except (KeyError, ValueError):
                    pass
        if not ready:
            raise self._timeout()
        for key, _ in ready:
            kind = key.data
            if kind == "stdout" and read_stdout and self.stdout_open:
                self._read(
                    self.stdout,
                    self.stdout_buffer,
                    stdout_limit,
                    "stdout",
                    extra=stdout_extra,
                )
            elif kind == "stderr" and self.stderr_open:
                self._read(self.stderr, self.stderr_buffer, LIVE_GIT_STDERR_BYTES, "stderr")
            elif kind == "stdin" and self.stdin_open and stdin_data is not None:
                try:
                    count = os.write(
                        self.stdin.fileno(),
                        stdin_data[stdin_offset : stdin_offset + LIVE_GIT_CHUNK_BYTES],
                    )
                except BrokenPipeError as error:
                    raise BackendSourceError("Git source query closed stdin unexpectedly") from error
                except BlockingIOError:
                    continue
                except OSError as error:
                    raise BackendSourceError(f"cannot write Git source query: {error}") from error
                stdin_offset += count
        return stdin_offset

    def write(self, data: bytes, *, read_stdout: bool, stdout_limit: int) -> None:
        if len(data) > MAX_MANIFEST_BYTES:
            raise BackendSourceError("Git source query input exceeds its size bound")
        offset = 0
        while offset < len(data):
            offset = self._pump(
                stdout_limit=stdout_limit,
                read_stdout=read_stdout,
                read_stdin=True,
                stdin_data=data,
                stdin_offset=offset,
            )

    def read_until(self, marker: bytes, maximum: int) -> bytes:
        while marker not in self.stdout_buffer:
            if not self.stdout_open:
                raise BackendSourceError("Git source query ended before its response was complete")
            self._pump(stdout_limit=maximum, stdout_extra=1)
        end = self.stdout_buffer.index(marker) + len(marker)
        value = bytes(self.stdout_buffer[:end])
        del self.stdout_buffer[:end]
        return value

    def read_exact(self, size: int) -> bytes:
        if size < 0:
            raise BackendSourceError("Git source query requested a negative response size")
        while len(self.stdout_buffer) < size:
            if not self.stdout_open:
                raise BackendSourceError("Git source query ended before its response was complete")
            self._pump(stdout_limit=size, stdout_extra=1)
        value = bytes(self.stdout_buffer[:size])
        del self.stdout_buffer[:size]
        return value

    def close_stdin(self) -> None:
        self._close_stdin()

    def collect(self, maximum: int) -> tuple[bytes, bytes, int]:
        self.close_stdin()
        while self.stdout_open or self.stderr_open:
            self._pump(stdout_limit=maximum, stdout_extra=0)
        try:
            returncode = self.process.wait(timeout=max(0.0, self.deadline - time.monotonic()))
        except subprocess.TimeoutExpired as error:
            raise self._timeout() from error
        self.returncode = returncode
        return bytes(self.stdout_buffer), bytes(self.stderr_buffer), returncode

    def finish(self) -> int:
        self.close_stdin()
        while self.stdout_open or self.stderr_open:
            self._pump(stdout_limit=0, stdout_extra=0)
        try:
            returncode = self.process.wait(timeout=max(0.0, self.deadline - time.monotonic()))
        except subprocess.TimeoutExpired as error:
            raise self._timeout() from error
        self.returncode = returncode
        return returncode

    def __enter__(self) -> "_LiveGitProcess":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if exc_type is not None:
            self._terminate()
        self._close_stdin()
        for stream, attribute in (
            (self.stdout, "stdout_open"),
            (self.stderr, "stderr_open"),
        ):
            if getattr(self, attribute):
                self._close(stream, attribute=attribute)
        self.selector.close()
        if exc_type is not None:
            self._log_query("failure", error_type=exc_type.__name__)
        elif self.returncode == 0:
            self._log_query("end", error_type=None)
        else:
            self._log_query(
                "failure",
                error_type="GitExit" if self.returncode is not None else "MissingReturnCode",
            )


def _live_git_command(source_root: Path, git_dir: Path, *arguments: str) -> tuple[str, ...]:
    # The index is written by the host Git and cannot be refreshed through the
    # read-only mount.  Inode, device, owner and sub-second times differ in the
    # container view, so the default stat check re-reads every tracked file on
    # each query.  Size and whole-second mtime survive the bind mount; content
    # identity is still established by the per-file SHA-256 of the capture.
    return (
        "git",
        "--git-dir",
        str(git_dir),
        "--work-tree",
        str(source_root),
        "-c",
        "core.filemode=false",
        "-c",
        "core.autocrlf=true",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.checkStat=minimal",
        "-c",
        "core.trustctime=false",
        *arguments,
    )


def _live_run_git(
    source_root: Path,
    git_dir: Path,
    *arguments: str,
    maximum: int = MAX_MANIFEST_BYTES,
    input_data: bytes | None = None,
) -> bytes:
    environment = os.environ.copy()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    environment["GIT_TERMINAL_PROMPT"] = "0"
    command = _live_git_command(source_root, git_dir, *arguments)
    with _LiveGitProcess(
        command,
        environment,
        query_label=_live_git_query_label(arguments),
    ) as process:
        if input_data is not None:
            if len(input_data) > MAX_MANIFEST_BYTES:
                raise BackendSourceError("Git source query input exceeds its size bound")
            process.write(input_data, read_stdout=True, stdout_limit=maximum)
        process.close_stdin()
        stdout, stderr, returncode = process.collect(maximum)
    if returncode:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise BackendSourceError(f"Git source query failed: {detail or 'unknown error'}")
    return stdout


def _live_read_bounded_regular(path: Path, label: str, maximum: int) -> bytes:
    descriptor: int | None = None
    try:
        metadata = path.lstat()
        if (
            stat.S_ISLNK(metadata.st_mode)
            or getattr(metadata, "st_file_attributes", 0) & 0x400
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_size <= 0
            or metadata.st_size > maximum
        ):
            _live_fail(f"{label} is not one bounded regular file")
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
        )
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size <= 0
            or before.st_size > maximum
        ):
            _live_fail(f"{label} is not one bounded regular file")
        chunks = bytearray()
        while len(chunks) <= maximum:
            chunk = os.read(descriptor, min(LIVE_GIT_CHUNK_BYTES, maximum + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        after = os.fstat(descriptor)
    except OSError as error:
        raise BackendSourceError(f"cannot read {label}") from error
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
    if len(chunks) > maximum or before.st_size != len(chunks):
        _live_fail(f"{label} exceeds its size bound or changed while being read")
    if (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    ) != (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    ):
        _live_fail(f"{label} changed while being read")
    return bytes(chunks)


def _live_windows_absolute(value: str) -> bool:
    return bool(re.match(r"^(?:[A-Za-z]:[\\/]|\\\\)", value))


def _live_normalize_windows_path(value: str, label: str) -> str:
    raw = value.strip().replace("/", "\\")
    path = PureWindowsPath(raw)
    if not path.is_absolute() or not path.drive:
        _live_fail(f"{label} is not an absolute Windows path")
    if any(part in {"", ".", ".."} for part in path.parts[1:]):
        _live_fail(f"{label} contains an unsafe Windows path component")
    return path.as_posix().rstrip("/").casefold()


def _live_normalize_posix_path(value: str, label: str) -> str:
    path = Path(value)
    if not path.is_absolute():
        _live_fail(f"{label} is not an absolute POSIX path")
    if any(part in {"", ".", ".."} for part in path.parts[1:]):
        _live_fail(f"{label} contains an unsafe POSIX path component")
    return str(path.resolve(strict=False))


def _live_validate_worktree_backref(source_root: Path, candidate: Path) -> None:
    raw = _live_read_bounded_regular(
        candidate / "gitdir",
        "live Git worktree gitdir back-reference",
        LIVE_GIT_MARKER_BYTES,
    )
    try:
        backref = raw.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        raise BackendSourceError("live Git worktree gitdir back-reference is not UTF-8") from error
    if not backref:
        _live_fail("live Git worktree gitdir back-reference is empty")
    expected_root = os.environ.get("FULLMAG_SOURCE_HOST_ROOT", "").strip()
    expected = str(Path(expected_root) / ".git") if expected_root else str(source_root / ".git")
    backref_windows = _live_windows_absolute(backref)
    expected_windows = _live_windows_absolute(expected)
    if backref_windows != expected_windows:
        _live_fail("live Git worktree gitdir back-reference uses the wrong path namespace")
    if backref_windows:
        observed_value = _live_normalize_windows_path(
            backref, "live Git worktree gitdir back-reference"
        )
        expected_value = _live_normalize_windows_path(
            expected, "selected host source root"
        )
    else:
        observed_value = _live_normalize_posix_path(
            backref, "live Git worktree gitdir back-reference"
        )
        expected_value = _live_normalize_posix_path(
            expected, "selected source root"
        )
    if observed_value != expected_value:
        _live_fail("live Git worktree gitdir back-reference differs from the selected source root")


def _live_git_dir(source_root: Path, git_common_root: Path) -> Path:
    """Resolve a worktree admin directory without trusting a Windows path.

    A Windows worktree exposes a text ``.git`` file whose absolute path is not
    meaningful inside the Linux container.  The mounted common directory still
    contains ``worktrees/<id>``; only that single basename is carried across
    the boundary.  A normal checkout uses the explicit common directory.
    """

    _live_assert_path(source_root, "live source root", directory=True)
    _live_assert_path(git_common_root, "live Git common root", directory=True)
    dot_git = source_root / ".git"
    try:
        metadata = dot_git.lstat()
    except FileNotFoundError:
        return git_common_root
    except OSError as error:
        raise BackendSourceError("cannot inspect live source .git marker") from error
    if stat.S_ISDIR(metadata.st_mode):
        return git_common_root
    if not stat.S_ISREG(metadata.st_mode):
        _live_fail("live source .git marker is not a directory or regular file")
    raw = _live_read_bounded_regular(
        dot_git,
        "live source .git marker",
        LIVE_GIT_MARKER_BYTES,
    )
    try:
        marker = raw.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        raise BackendSourceError("live source .git marker is not UTF-8") from error
    if not marker.startswith("gitdir:"):
        _live_fail("live source .git marker has no gitdir target")
    target = marker[len("gitdir:") :].strip().replace("\\", "/")
    parts = [part for part in target.split("/") if part]
    try:
        index = len(parts) - 1 - parts[::-1].index("worktrees")
    except ValueError:
        _live_fail("live source .git marker does not identify a mounted worktree")
    tail = parts[index + 1 :]
    if len(tail) != 1 or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", tail[0]):
        _live_fail("live source .git worktree marker is invalid")
    candidate = git_common_root / "worktrees" / tail[0]
    _live_assert_path(candidate, "live Git worktree admin directory", directory=True)
    _live_validate_worktree_backref(source_root, candidate)
    return candidate


def _live_parse_git_records(raw: bytes, label: str) -> list[tuple[str, str, str]]:
    records: list[tuple[str, str, str]] = []
    for item in raw.split(b"\0"):
        if not item:
            continue
        header, separator, raw_path = item.partition(b"\t")
        fields = header.split(b" ")
        if not separator or len(fields) != 3:
            _live_fail(f"cannot parse {label}")
        try:
            mode, kind, object_id = (field.decode("ascii") for field in fields)
            relative = _live_safe_relative(raw_path.decode("utf-8"), label)
        except (UnicodeDecodeError, ValueError) as error:
            raise BackendSourceError(f"cannot decode {label}") from error
        if not SHA40_RE.fullmatch(object_id):
            _live_fail(f"{label} contains an invalid Git object id")
        records.append((relative, mode, kind + ":" + object_id))
    return records


def _live_admin_path(relative: str) -> bool:
    return any(part.casefold() in LIVE_ADMIN_EXCLUDED_DIRECTORIES for part in relative.split("/"))


def _live_reject_policy(relative: str) -> None:
    parts = relative.split("/")
    if any(part.casefold() in LIVE_SOURCE_EXCLUDED_DIRECTORIES for part in parts):
        _live_fail(f"live source contains a generated or administrative path: {relative}")
    basename = parts[-1].casefold()
    if basename in {".git-credentials", ".netrc", ".npmrc", ".pypirc", "credentials.json", "secrets.json", "secret.json"}:
        _live_fail(f"live source contains credential material: {relative}")
    if basename == ".env" or (basename.startswith(".env.") and basename != ".env.example"):
        _live_fail(f"live source contains a secret environment file: {relative}")


def _live_normalize_excluded(values: list[object]) -> list[object]:
    unique: dict[str, object] = {}
    for value in values:
        if isinstance(value, str):
            _live_safe_relative(value, "live source exclusion")
            unique[json.dumps(value, ensure_ascii=False, separators=(",", ":"))] = value
        elif isinstance(value, dict):
            path = value.get("path")
            pinned = value.get("pinned_commit")
            if (
                not isinstance(path, str)
                or path not in LIVE_ALLOWED_GITLINKS
                or value.get("type") != "gitlink"
                or not isinstance(pinned, str)
                or not SHA40_RE.fullmatch(pinned)
            ):
                _live_fail("live source Gitlink exclusion is invalid")
            item = {"path": path, "type": "gitlink", "pinned_commit": pinned}
            unique[json.dumps(item, ensure_ascii=False, separators=(",", ":"), sort_keys=True)] = item
        else:
            _live_fail("live source exclusion is invalid")
    return [unique[key] for key in sorted(unique)]


def _live_index(
    source_root: Path, git_dir: Path, exclusions: list[object]
) -> tuple[dict[str, tuple[str, str, int]], dict[str, list[dict[str, object]]], set[str]]:
    raw = _live_run_git(source_root, git_dir, "ls-files", "--stage", "-z")
    records: dict[str, tuple[str, str, int]] = {}
    native_entries: dict[str, list[dict[str, object]]] = {}
    gitlinks: set[str] = set()
    for item in raw.split(b"\0"):
        if not item:
            continue
        header, separator, raw_path = item.partition(b"\t")
        fields = header.split(b" ")
        if not separator or len(fields) != 3:
            _live_fail("cannot parse Git index")
        try:
            mode, object_id, raw_stage = (field.decode("ascii") for field in fields)
            relative = _live_safe_relative(raw_path.decode("utf-8"), "Git index")
            stage = int(raw_stage)
        except (UnicodeDecodeError, ValueError) as error:
            raise BackendSourceError("cannot decode Git index") from error
        if not SHA40_RE.fullmatch(object_id) or stage not in {0, 1, 2, 3}:
            _live_fail(f"Git index entry is invalid: {relative}")
        if stage != 0:
            _live_fail(f"unmerged Git index entry: {relative}")
        fields = (mode, object_id, stage)
        if mode == "160000":
            gitlinks.add(relative)
            if relative not in LIVE_ALLOWED_GITLINKS:
                _live_fail(f"unsupported Gitlink in live source: {relative}")
            exclusions.append({"path": relative, "type": "gitlink", "pinned_commit": object_id})
            continue
        if _live_admin_path(relative):
            exclusions.append(relative)
            continue
        _live_reject_policy(relative)
        if mode == "120000":
            _live_fail(f"live source contains a symlink: {relative}")
        if mode not in {"100644", "100755"}:
            _live_fail(f"unsupported Git index entry at {relative}")
        records[relative] = fields
        native_entries[relative] = [{"mode": mode, "object_id": object_id, "stage": stage}]
    return records, native_entries, gitlinks


def _live_tree(raw: bytes, exclusions: list[object]) -> dict[str, tuple[str, str]]:
    records: dict[str, tuple[str, str]] = {}
    for relative, mode, descriptor in _live_parse_git_records(raw, "committed Git tree"):
        kind, object_id = descriptor.split(":", 1)
        if mode == "160000" or kind == "commit":
            if relative not in LIVE_ALLOWED_GITLINKS:
                _live_fail(f"unsupported Gitlink in live source: {relative}")
            exclusions.append({"path": relative, "type": "gitlink", "pinned_commit": object_id})
            continue
        if _live_admin_path(relative):
            exclusions.append(relative)
            continue
        _live_reject_policy(relative)
        if mode == "120000":
            _live_fail(f"live source contains a committed symlink: {relative}")
        if mode not in {"100644", "100755"} or kind != "blob":
            _live_fail(f"unsupported committed source entry at {relative}")
        records[relative] = (mode, object_id)
    return records


def _live_runtime_status_pathspecs(tree_bytes: bytes) -> tuple[str, ...]:
    """Build the canonical runtime-only status pathspec from the HEAD tree."""
    top_level: set[str] = set()
    for relative, _mode, _descriptor in _live_parse_git_records(tree_bytes, "committed Git tree"):
        top_level.add(relative.split("/", 1)[0])
    pathspecs = [path for path in sorted(top_level) if not _live_non_runtime(path)]
    if not pathspecs:
        _live_fail("cannot construct runtime source pathspecs")
    return tuple([*pathspecs, ":(top)*", *LIVE_RUNTIME_STATUS_EXCLUSIONS])


def _live_check_lfs_attributes(source_root: Path, git_dir: Path, paths: list[str]) -> None:
    if not paths:
        return
    input_data = b"\0".join(path.encode("utf-8") for path in paths) + b"\0"
    try:
        raw = _live_run_git(
            source_root,
            git_dir,
            "check-attr",
            "-z",
            "--cached",
            "--stdin",
            "filter",
            maximum=MAX_MANIFEST_BYTES,
            input_data=input_data,
        )
    except BackendSourceError as error:
        if "Git source query failed:" not in str(error):
            raise BackendSourceError(f"cannot inspect Git-LFS attributes: {error}") from error
        raise
    fields = raw.split(b"\0")
    if not fields or fields[-1] != b"" or (len(fields) - 1) % 3:
        _live_fail("Git-LFS attribute response is malformed")
    for index in range(0, len(fields) - 2, 3):
        path, attribute, value = fields[index : index + 3]
        if attribute == b"filter" and value == b"lfs":
            try:
                relative = path.decode("utf-8")
            except UnicodeDecodeError:
                relative = "<undecodable path>"
            _live_fail(f"Git-LFS attribute is not materialized: {relative}")


def _live_read_blobs(git_dir: Path, object_ids: Mapping[str, str]) -> dict[str, bytes]:
    if not object_ids:
        return {}
    environment = os.environ.copy()
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    command = ("git", "--git-dir", str(git_dir), "cat-file", "--batch")
    result: dict[str, bytes] = {}
    with _LiveGitProcess(command, environment, query_label="cat-file-batch") as process:
        for relative, object_id in object_ids.items():
            process.write(
                (object_id + "\n").encode("ascii"),
                read_stdout=False,
                stdout_limit=LIVE_GIT_HEADER_BYTES,
            )
            header = process.read_until(b"\n", LIVE_GIT_HEADER_BYTES).rstrip(b"\n").split(b" ")
            if len(header) != 3 or header[0].decode("ascii", "replace") != object_id or header[1] != b"blob":
                _live_fail(f"Git sparse source object is invalid: {relative}")
            try:
                size = int(header[2])
            except ValueError as error:
                raise BackendSourceError(f"Git sparse source object size is invalid: {relative}") from error
            if size < 0 or size > MAX_FILE_BYTES:
                _live_fail(f"Git sparse source object exceeds its size bound: {relative}")
            content = process.read_exact(size)
            if process.read_exact(1) != b"\n":
                _live_fail(f"Git sparse source object is truncated: {relative}")
            if LIVE_LFS_POINTER_RE.match(content):
                _live_fail(f"Git-LFS pointer is not materialized: {relative}")
            result[relative] = content
        returncode = process.finish()
        if returncode:
            detail = bytes(process.stderr_buffer).decode("utf-8", errors="replace").strip()
            _live_fail(f"Git sparse source object read failed: {detail or 'Git error'}")
    return result


def _live_skip_worktree(source_root: Path, git_dir: Path) -> set[str]:
    result: set[str] = set()
    raw = _live_run_git(source_root, git_dir, "ls-files", "-t", "-z")
    for item in raw.split(b"\0"):
        if not item:
            continue
        if len(item) < 3 or item[1:2] != b" ":
            _live_fail("cannot parse Git tracked-path status")
        if item[:1] == b"S":
            try:
                result.add(_live_safe_relative(item[2:].decode("utf-8"), "Git tracked path"))
            except UnicodeDecodeError as error:
                raise BackendSourceError("cannot decode Git tracked path") from error
    return result


def _live_regular_path(source_root: Path, relative: str) -> Path | None:
    path = source_root.joinpath(*PurePosixPath(relative).parts)
    current = source_root
    for part in PurePosixPath(relative).parts[:-1]:
        current /= part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400 or not stat.S_ISDIR(metadata.st_mode):
            _live_fail(f"live source path traverses an unsafe parent: {relative}")
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
        _live_fail(f"live source entry is a symlink or reparse point: {relative}")
    if not stat.S_ISREG(metadata.st_mode):
        _live_fail(f"live source entry is not a regular file: {relative}")
    return path


def _live_metadata_signature(metadata: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _live_read_regular(source_root: Path, relative: str) -> tuple[str, bytes] | None:
    path = _live_regular_path(source_root, relative)
    if path is None:
        return None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError as error:
        raise LiveSourceChanged(f"live source file disappeared while being read: {relative}") from error
    except OSError as error:
        raise BackendSourceError(f"cannot open live source file {relative}") from error
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            _live_fail(f"live source file is not one regular file: {relative}")
        content = bytearray()
        while len(content) <= MAX_FILE_BYTES:
            block = os.read(descriptor, min(1024 * 1024, MAX_FILE_BYTES + 1 - len(content)))
            if not block:
                break
            content.extend(block)
        after = os.fstat(descriptor)
    except OSError as error:
        raise BackendSourceError(f"cannot read live source file {relative}") from error
    finally:
        os.close(descriptor)
    if len(content) > MAX_FILE_BYTES:
        _live_fail(f"live source file exceeds its size bound: {relative}")
    if before.st_size != len(content) or _live_metadata_signature(before) != _live_metadata_signature(after):
        raise LiveSourceChanged(f"live source file changed while being read: {relative}")
    if LIVE_LFS_POINTER_RE.match(bytes(content)):
        _live_fail(f"Git-LFS pointer is not materialized: {relative}")
    return ("100755" if before.st_mode & stat.S_IXUSR else "100644", bytes(content))




def _live_hash_regular(source_root: Path, relative: str) -> tuple[str, int, str] | None:
    """Hash one regular source file without retaining its content in memory."""
    path = _live_regular_path(source_root, relative)
    if path is None:
        return None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError as error:
        raise LiveSourceChanged(f"live source file disappeared while being read: {relative}") from error
    except OSError as error:
        raise BackendSourceError(f"cannot open live source file {relative}") from error
    digest = hashlib.sha256()
    total = 0
    prefix = bytearray()
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            _live_fail(f"live source file is not one regular file: {relative}")
        while total <= MAX_FILE_BYTES:
            block = os.read(
                descriptor,
                min(LIVE_HASH_CHUNK_BYTES, MAX_FILE_BYTES + 1 - total),
            )
            if not block:
                break
            total += len(block)
            digest.update(block)
            if len(prefix) < LIVE_GIT_MARKER_BYTES:
                prefix.extend(block[: LIVE_GIT_MARKER_BYTES - len(prefix)])
        after = os.fstat(descriptor)
    except OSError as error:
        raise BackendSourceError(f"cannot read live source file {relative}") from error
    finally:
        os.close(descriptor)
    if total > MAX_FILE_BYTES:
        _live_fail(f"live source file exceeds its size bound: {relative}")
    if before.st_size != total or _live_metadata_signature(before) != _live_metadata_signature(after):
        raise LiveSourceChanged(f"live source file changed while being read: {relative}")
    # Normal Git-LFS pointers are well below the bounded probe.  Keep the
    # probe bounded while preserving the existing exact check for such files.
    if LIVE_LFS_POINTER_RE.match(bytes(prefix)):
        _live_fail(f"Git-LFS pointer is not materialized: {relative}")
    return (
        "100755" if before.st_mode & stat.S_IXUSR else "100644",
        total,
        digest.hexdigest(),
    )


class _LiveHashCache:
    """Reuse a file digest only while size, nanosecond mtime and mode are unchanged.

    Reading every tracked file through the Windows bind mount dominated the
    capture.  The key is observed before hashing, so a save during the read
    leaves a stale key that simply misses on the next capture.
    """

    def __init__(self, entries: Mapping[str, list[object]] | None = None) -> None:
        self.known = dict(entries or {})
        self.observed: dict[str, list[object]] = {}
        self.hits = 0
        self._lock = threading.Lock()

    def hash(self, source_root: Path, relative: str) -> tuple[str, int, str] | None:
        path = _live_regular_path(source_root, relative)
        if path is None:
            return None
        try:
            metadata = path.lstat()
        except FileNotFoundError as error:
            raise LiveSourceChanged(f"live source file disappeared while being read: {relative}") from error
        mode = "100755" if metadata.st_mode & stat.S_IXUSR else "100644"
        key: list[object] = [metadata.st_size, metadata.st_mtime_ns, mode]
        cached = self.known.get(relative)
        hit = cached is not None and cached[:3] == key
        if hit:
            result: tuple[str, int, str] | None = (mode, metadata.st_size, str(cached[3]))
        else:
            result = _live_hash_regular(source_root, relative)
            if result is None:
                return None
        with self._lock:
            if hit:
                self.hits += 1
            if result[0] == mode and result[1] == metadata.st_size:
                self.observed[relative] = [*key, result[2]]
        return result


def _live_hash_cache_path(build_root: Path) -> Path:
    return build_root / LIVE_MANIFEST_DIRNAME / LIVE_HASH_CACHE_FILENAME


def _load_live_hash_cache(build_root: Path, source_root: Path) -> _LiveHashCache:
    """Return the previous capture's digests, or an empty cache when unusable."""

    path = _live_hash_cache_path(build_root)
    try:
        document = json.loads(
            _live_read_bounded_regular(path, "live source hash cache", MAX_MANIFEST_BYTES)
        )
    except (BackendSourceError, OSError, ValueError):
        return _LiveHashCache()
    entries = document.get("entries") if isinstance(document, dict) else None
    if (
        document.get("schema") != LIVE_HASH_CACHE_SCHEMA
        or document.get("source_root") != str(source_root)
        or not isinstance(entries, dict)
    ):
        return _LiveHashCache()
    checked: dict[str, list[object]] = {}
    for relative, value in entries.items():
        if not (
            isinstance(relative, str)
            and isinstance(value, list)
            and len(value) == 4
            and type(value[0]) is int
            and type(value[1]) is int
            and value[2] in {"100644", "100755"}
            and isinstance(value[3], str)
            and re.fullmatch(r"[0-9a-f]{64}", value[3])
        ):
            return _LiveHashCache()
        checked[relative] = value
    return _LiveHashCache(checked)


def _save_live_hash_cache(
    build_root: Path, source_root: Path, cache: _LiveHashCache, relatives: set[str]
) -> None:
    """Persist digests of the published manifest's files; failure only costs speed."""

    path = _live_hash_cache_path(build_root)
    document = {
        "schema": LIVE_HASH_CACHE_SCHEMA,
        "source_root": str(source_root),
        "entries": {
            relative: value
            for relative, value in sorted(cache.observed.items())
            if relative in relatives
        },
    }
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(_live_canonical(document))
        os.replace(temporary, path)
    except OSError:
        pass
    finally:
        try:
            temporary.unlink()
        except OSError:
            pass


def _live_hash_regular_files(
    source_root: Path, relatives: list[str], cache: _LiveHashCache | None = None
) -> dict[str, tuple[str, int, str] | None]:
    """Hash sorted source paths with at most eight in-flight reads."""
    worker = _live_hash_regular if cache is None else cache.hash
    relatives = sorted(relatives)
    result: dict[str, tuple[str, int, str] | None] = {}
    iterator = iter(relatives)
    pending = {}
    with ThreadPoolExecutor(max_workers=LIVE_HASH_WORKERS) as executor:
        for _ in range(LIVE_HASH_WORKERS):
            try:
                relative = next(iterator)
            except StopIteration:
                break
            pending[executor.submit(worker, source_root, relative)] = relative
        while pending:
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                relative = pending.pop(future)
                result[relative] = future.result()
                try:
                    next_relative = next(iterator)
                except StopIteration:
                    continue
                pending[executor.submit(worker, source_root, next_relative)] = next_relative
    return {relative: result[relative] for relative in relatives}


def _live_parse_status(raw: bytes) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    parts = raw.split(b"\0")
    index = 0
    while index < len(parts) and parts[index]:
        item = parts[index]
        index += 1
        if len(item) < 4 or item[2:3] != b" ":
            _live_fail("cannot parse live Git status")
        try:
            status = item[:2].decode("ascii")
            paths = [_live_safe_relative(item[3:].decode("utf-8"), "Git status")]
        except UnicodeDecodeError as error:
            raise BackendSourceError("cannot decode live Git status") from error
        if status[0] in "RC" or status[1] in "RC":
            if index >= len(parts) or not parts[index]:
                _live_fail("cannot parse live Git rename status")
            try:
                paths.append(_live_safe_relative(parts[index].decode("utf-8"), "Git status"))
            except UnicodeDecodeError as error:
                raise BackendSourceError("cannot decode live Git rename status") from error
            index += 1
        records.append({"status": status, "paths": paths})
    return records


def _live_untracked_script_output(relative: str) -> bool:
    """Exclude only untracked result files in the operator-approved output directory.

    Tracked fixtures never pass through this function and remain bound to the
    package identity. New source code in the same directory is still dirty.
    """
    if os.environ.get("FULLMAG_SCRIPT_OUTPUT_ROOT") != "/opt/fullmag/script-output":
        return False
    configured = PurePosixPath(os.environ.get("FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR", ""))
    try:
        directory = configured.relative_to(PurePosixPath("/opt/fullmag/source"))
        if not directory.parts or ".." in directory.parts:
            return False
        child = PurePosixPath(relative).relative_to(directory)
    except ValueError:
        return False
    parts = child.parts
    if not parts:
        return False
    name = parts[-1].casefold()
    return (
        name.endswith((".fms", ".h5"))
        or bool(re.fullmatch(r"\..+\.[0-9a-f-]{36}\.fms\.part", name))
        or any(part.casefold().endswith((".zarr", ".results")) for part in parts[:-1])
        or any(part == ".fullmag-tmp" for part in parts[:-1])
    )


def _live_windows_device_component(component: str) -> bool:
    stem = component.split(".", 1)[0].rstrip(" .").casefold()
    return (
        stem in {"con", "prn", "aux", "nul", "conin$", "conout$"}
        or bool(re.fullmatch(r"(?:com|lpt)(?:[1-9]|[¹²³])", stem))
    )


def _live_included_untracked_from_environment() -> tuple[str, ...]:
    """Read the one canonical, explicitly pinned live-source allowlist."""

    raw = os.environ.get("FULLMAG_DEV_INCLUDE_UNTRACKED", "[]")
    try:
        encoded = raw.encode("utf-8")
    except UnicodeEncodeError as error:
        raise BackendSourceError("included untracked source allowlist is not UTF-8") from error
    if len(encoded) > MAX_MANIFEST_BYTES:
        _live_fail("included untracked source allowlist exceeds its size bound")
    try:
        values = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as error:
        raise BackendSourceError("included untracked source allowlist is not valid JSON") from error
    if not isinstance(values, list) or len(values) > MAX_MEMBERS:
        _live_fail("included untracked source allowlist must be a bounded JSON array")
    paths: list[str] = []
    for value in values:
        if not isinstance(value, str):
            _live_fail("included untracked source allowlist entries must be strings")
        relative = _live_safe_relative(value, "included untracked source")
        if any(character in relative for character in "*?[]"):
            _live_fail(f"included untracked source path cannot contain glob syntax: {relative}")
        if any(_live_windows_device_component(part) for part in relative.split("/")):
            _live_fail(f"included untracked source path uses a Windows device name: {relative}")
        _live_reject_policy(relative)
        if _live_admin_path(relative) or _live_untracked_script_output(relative):
            _live_fail(f"included untracked source path is excluded by policy: {relative}")
        paths.append(relative)
    if len(paths) != len(set(paths)) or paths != sorted(paths):
        _live_fail("included untracked source paths must be unique and sorted")
    if raw != json.dumps(paths, ensure_ascii=False, separators=(",", ":")):
        _live_fail("included untracked source allowlist is not canonical JSON")
    return tuple(paths)


def _live_untracked_records(raw: bytes) -> tuple[list[str], list[dict[str, object]]]:
    paths: list[str] = []
    records: list[dict[str, object]] = []
    for item in raw.split(b"\0"):
        if not item:
            continue
        try:
            relative = _live_safe_relative(item.decode("utf-8"), "untracked source")
        except UnicodeDecodeError as error:
            raise BackendSourceError("cannot decode untracked source path") from error
        if _live_untracked_script_output(relative):
            continue
        paths.append(relative)
        records.append({"status": "??", "paths": [relative]})
    return paths, records


def _live_auto_untracked(source_root: Path, relative: str) -> bool:
    """Select a new, non-ignored runtime source file without an explicit allowlist.

    A new module that is not yet staged must compile like a tracked one.
    Paths that policy would reject, administrative and non-runtime trees, and
    large files are left out silently; an explicit allowlist still overrides.
    """

    if _live_admin_path(relative) or _live_non_runtime(relative):
        return False
    if any(_live_windows_device_component(part) for part in relative.split("/")):
        return False
    try:
        _live_reject_policy(relative)
        path = _live_regular_path(source_root, relative)
    except BackendSourceError:
        return False
    if path is None:
        return False
    try:
        return path.lstat().st_size <= LIVE_AUTO_UNTRACKED_MAX_BYTES
    except OSError:
        return False


def _live_non_runtime(relative: str) -> bool:
    return (
        relative in LIVE_NON_RUNTIME_EXACT
        or relative.startswith(LIVE_NON_RUNTIME_PREFIXES)
        or relative.endswith(LIVE_NON_RUNTIME_SUFFIXES)
    )


def _live_dirty_entry(source_root: Path, relative: str) -> tuple[str, str, bytes] | None:
    path = source_root.joinpath(*PurePosixPath(relative).parts)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(metadata.st_mode):
        try:
            raw_target = os.readlink(path)
        except OSError as error:
            raise BackendSourceError(f"cannot read dirty source symlink: {relative}") from error
        if (
            not raw_target
            or PurePosixPath(raw_target).is_absolute()
            or PureWindowsPath(raw_target).is_absolute()
        ):
            _live_fail(f"dirty source symlink escapes its root: {relative}")
        try:
            target_path = (path.parent / raw_target).resolve(strict=False)
            target_path.relative_to(source_root.resolve(strict=True))
        except (OSError, RuntimeError, ValueError) as error:
            raise BackendSourceError(f"dirty source symlink escapes its root: {relative}") from error
        return "symlink_target", "120000", os.fsencode(raw_target)
    if not stat.S_ISREG(metadata.st_mode):
        _live_fail(f"dirty source entry is not regular or symlink: {relative}")
    current = _live_read_regular(source_root, relative)
    if current is None:
        return None
    mode, content = current
    return "regular_file", mode, content


def _live_native_identity(
    source_root: Path,
    git_dir: Path,
    head: str,
    tree_bytes: bytes,
    status_records: list[dict[str, object]],
    index_entries: Mapping[str, list[dict[str, object]]],
    gitlinks: set[str],
) -> dict[str, Any]:
    filtered_status = [
        record
        for record in status_records
        if any(
            not _live_non_runtime(path)
            and not any(path == gitlink or path.startswith(gitlink + "/") for gitlink in gitlinks)
            for path in record["paths"]
        )
    ]
    dirty_paths = sorted({path for record in filtered_status for path in record["paths"]})
    dirty_content: list[dict[str, object]] = []
    for relative in dirty_paths:
        current = _live_dirty_entry(source_root, relative)
        entries = list(index_entries.get(relative, ()))
        if current is None:
            dirty_content.append(
                {"path": relative, "kind": "missing", "mode": "000000", "git_index_entries": entries}
            )
            continue
        kind, mode, content = current
        dirty_content.append(
            {
                "path": relative,
                "kind": kind,
                "mode": mode,
                "sha256": _live_sha256(content),
                "git_index_entries": entries,
            }
        )
    payload: dict[str, object] = {
        "schema": "fullmag.source-snapshot.v2",
        "head_commit_full": head,
        "head_tree_sha256": _live_sha256(tree_bytes),
        "git_status_porcelain_v1": filtered_status,
        "dirty_path_content": dirty_content,
        "ignored_non_runtime_dirty": True,
    }
    return {
        **payload,
        "source_snapshot_dirty": bool(filtered_status),
        "dirty_content_sha256": _live_sha256(_live_canonical(dirty_content)),
        "source_snapshot_sha256": _live_sha256(_live_canonical(payload)),
    }


def _capture_live_source_once(
    source_root: Path,
    git_common_root: Path,
    included_untracked: tuple[str, ...] = (),
    hash_cache: _LiveHashCache | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, str]]:
    git_dir = _live_git_dir(source_root, git_common_root)
    try:
        head = _live_run_git(source_root, git_dir, "rev-parse", "--verify", "HEAD", maximum=4096).decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise BackendSourceError("live source Git HEAD is not ASCII") from error
    if not SHA40_RE.fullmatch(head):
        _live_fail("live source Git HEAD is not a full commit SHA")
    tree_bytes = _live_run_git(source_root, git_dir, "ls-tree", "-r", "-z", "--full-tree", head)
    exclusions: list[object] = []
    tree = _live_tree(tree_bytes, exclusions)
    index, native_index, gitlinks = _live_index(source_root, git_dir, exclusions)
    records = dict(tree)
    records.update({path: (mode, object_id) for path, (mode, object_id, _stage) in index.items()})
    _live_check_lfs_attributes(source_root, git_dir, sorted(records))
    skip_worktree = _live_skip_worktree(source_root, git_dir)
    files: list[dict[str, Any]] = []
    deleted: list[str] = []
    sparse_objects: dict[str, str] = {}
    current_files = _live_hash_regular_files(source_root, sorted(records), hash_cache)
    for relative in sorted(records):
        mode, object_id = records[relative]
        current = current_files[relative]
        if current is None:
            if relative in skip_worktree and mode in {"100644", "100755"}:
                sparse_objects[relative] = object_id
                continue
            deleted.append(relative)
            continue
        current_mode, size, digest = current
        files.append(
            {
                "path": relative,
                "type": "file",
                "mode": current_mode,
                "size": size,
                "sha256": digest,
            }
        )
    sparse = _live_read_blobs(git_dir, sparse_objects)
    for relative in sorted(sparse_objects):
        content = sparse[relative]
        files.append(
            {
                "path": relative,
                "type": "file",
                "mode": records[relative][0],
                "size": len(content),
                "sha256": _live_sha256(content),
            }
        )
    # Gitlink pins are authenticated from the HEAD tree and index and are
    # disclosed in ``excluded``.  Native identity filters those paths, so
    # status must not descend into their nested worktrees.
    status_raw = _live_run_git(
        source_root,
        git_dir,
        "status",
        "--porcelain=v1",
        "-z",
        "--no-renames",
        "--untracked-files=no",
        "--ignore-submodules=all",
        "--",
        *_live_runtime_status_pathspecs(tree_bytes),
        maximum=MAX_MANIFEST_BYTES,
    )
    status_records = _live_parse_status(status_raw)
    untracked_raw = _live_run_git(
        source_root,
        git_dir,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        maximum=MAX_MANIFEST_BYTES,
    )
    untracked_paths, untracked_records = _live_untracked_records(untracked_raw)
    included_set = set(included_untracked)
    available_untracked = set(untracked_paths)
    already_tracked = {entry["path"] for entry in files}
    missing_untracked = sorted(included_set - available_untracked - already_tracked)
    if missing_untracked:
        _live_fail(
            "included source paths are neither exact non-ignored untracked files nor present tracked files: "
            + ", ".join(missing_untracked[:20])
        )
    selected_untracked = tuple(
        sorted(
            {relative for relative in included_untracked if relative in available_untracked}
            | {
                relative
                for relative in untracked_paths
                if relative not in included_set and _live_auto_untracked(source_root, relative)
            }
        )
    )
    included_set |= set(selected_untracked)
    selected_files = _live_hash_regular_files(source_root, list(selected_untracked), hash_cache)
    for relative in selected_untracked:
        selected = selected_files[relative]
        if selected is None:
            raise LiveSourceChanged(f"included untracked source disappeared during capture: {relative}")
        mode, size, digest = selected
        files.append(
            {
                "path": relative,
                "type": "file",
                "mode": mode,
                "size": size,
                "sha256": digest,
            }
        )
    exclusions = [
        value
        for value in exclusions
        if not (isinstance(value, str) and value in included_set)
    ]
    exclusions.extend(path for path in untracked_paths if path not in included_set)
    status_records.extend(untracked_records)
    excluded = _live_normalize_excluded(exclusions)
    files.sort(key=lambda entry: entry["path"])
    native = _live_native_identity(
        source_root, git_dir, head, tree_bytes, status_records, native_index, gitlinks
    )
    manifest_files = {entry["path"]: entry for entry in files}
    native_dirty_files = {
        entry["path"]: entry for entry in native["dirty_path_content"]
    }
    for relative in selected_untracked:
        if _live_non_runtime(relative):
            continue
        manifest_entry = manifest_files[relative]
        native_entry = native_dirty_files.get(relative)
        if (
            not isinstance(native_entry, dict)
            or native_entry.get("kind") != "regular_file"
            or native_entry.get("mode") != manifest_entry["mode"]
            or native_entry.get("sha256") != manifest_entry["sha256"]
        ):
            # Both reads come from the same capture pass, so a difference means
            # the file was saved in between.
            raise LiveSourceChanged(
                "native source identity does not bind the included file bytes: "
                + relative
            )
    capsule_core = {
        "schema_version": "fullmag.source-capsule.v1",
        "source_mode": "snapshot",
        "resolved_commit": head,
        "files": files,
        "deleted": sorted(deleted),
        "included_untracked": list(selected_untracked),
        "excluded": excluded,
    }
    source_digest = _live_sha256(_live_canonical(capsule_core))
    capsule = {
        "schema_version": "fullmag.source-capsule.v1",
        "schema": "fullmag.source-capsule.v1",
        "manifest_filename": "manifest.json",
        "source_mode": "snapshot",
        "repo_root": str(source_root),
        "git_common_dir": str(git_common_root),
        "requested_ref": None,
        "resolved_commit": head,
        "head_commit": head,
        "dirty": True,
        # This is deliberately the backend/runtime observation after the
        # canonical runtime and Gitlink filters, not a full Git status flag.
        "working_tree_dirty": bool(native["source_snapshot_dirty"]),
        "files": files,
        "entries": files,
        "deleted": sorted(deleted),
        "included_untracked": list(selected_untracked),
        "excluded": excluded,
        "source_digest": source_digest,
        "source_digest_sha256": source_digest,
    }
    return capsule, native, sparse_objects


def _capture_live_source_pass(
    source_root: Path,
    git_common_root: Path,
    pass_number: int,
    included_untracked: tuple[str, ...] = (),
    hash_cache: _LiveHashCache | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, str]]:
    started = time.monotonic()
    print(f"fullmag-live-source capture_pass={pass_number} phase=start", file=sys.stderr, flush=True)
    try:
        result = _capture_live_source_once(
            source_root, git_common_root, included_untracked, hash_cache
        )
    except Exception as error:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        print(
            f"fullmag-live-source capture_pass={pass_number} phase=end outcome=error "
            f"error_type={type(error).__name__} elapsed_ms={elapsed_ms}",
            file=sys.stderr,
            flush=True,
        )
        raise
    capsule, native, _git_object_ids = result
    elapsed_ms = int((time.monotonic() - started) * 1000)
    print(
        f"fullmag-live-source capture_pass={pass_number} phase=end outcome=success "
        f"files={len(capsule['files'])} deleted={len(capsule['deleted'])} "
        f"status={len(native['git_status_porcelain_v1'])} excluded={len(capsule['excluded'])} "
        f"hash_cache_hits={hash_cache.hits if hash_cache is not None else 0} "
        f"elapsed_ms={elapsed_ms}",
        file=sys.stderr,
        flush=True,
    )
    return result


def capture_live_source_manifest(
    source_root: Path, git_common_root: Path, build_root: Path
) -> Path:
    """Capture the mounted checkout into a closed ext4 live-source manifest.

    The source and Git mounts are read-only.  Only this helper's manifest is
    written, under the image-owned build root; the existing backend worker then
    performs the normal manifest validation and ext4 shadow reconciliation.

    One pass is enough: the shadow synchronization re-hashes every copied file
    against this manifest, and a file edited after the capture is detected
    there and answered with a fresh capture instead of a failed start.
    """

    source_root = Path(source_root)
    git_common_root = Path(git_common_root)
    build_root = Path(build_root)
    included_untracked = _live_included_untracked_from_environment()
    previous_hashes = _load_live_hash_cache(build_root, source_root)
    for attempt in range(1, LIVE_CAPTURE_ATTEMPTS + 1):
        hash_cache = _LiveHashCache(previous_hashes.known)
        try:
            capsule, native, git_object_ids = _capture_live_source_pass(
                source_root, git_common_root, attempt, included_untracked, hash_cache
            )
            break
        except LiveSourceChanged:
            if attempt == LIVE_CAPTURE_ATTEMPTS:
                raise
            time.sleep(LIVE_CAPTURE_RETRY_SECONDS)
    capture_id = uuid.uuid4().hex
    document: dict[str, Any] = {
        "schema": LIVE_MANIFEST_SCHEMA,
        "capture_id": capture_id,
        "source_mode": LIVE_SOURCE_MODE,
        "source_root": str(source_root),
        "git_common_dir": str(git_common_root),
        "resolved_commit": capsule["resolved_commit"],
        "source_digest": capsule["source_digest"],
        "source_snapshot_sha256": native["source_snapshot_sha256"],
        "native_source_identity": native,
        "source_manifest": capsule,
        "source_manifest_sha256": _live_sha256(_live_canonical(capsule)),
        "git_object_ids": git_object_ids,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    document["live_manifest_sha256"] = _live_sha256(_live_canonical(document))
    _live_assert_path(build_root, "live source build root", directory=True)
    destination = build_root / LIVE_MANIFEST_DIRNAME
    destination.mkdir(exist_ok=True)
    _live_assert_path(destination, "live source manifest directory", directory=True)
    manifest_path = destination / LIVE_MANIFEST_FILENAME
    temporary = destination / f".{LIVE_MANIFEST_FILENAME}.{capture_id}.tmp"
    data = _live_canonical(document)
    descriptor: int | None = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o640,
        )
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                _live_fail("short write while publishing live source manifest")
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, manifest_path)
        try:
            descriptor = os.open(destination, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            os.fsync(descriptor)
        finally:
            if descriptor is not None:
                os.close(descriptor)
        try:
            manifest_path.chmod(0o444)
        except OSError:
            pass
    except OSError as error:
        raise BackendSourceError(f"cannot publish closed live source manifest: {error}") from error
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        except OSError as error:
            raise BackendSourceError("cannot clean live source manifest temporary file") from error
    _save_live_hash_cache(
        build_root, source_root, hash_cache, {entry["path"] for entry in capsule["files"]}
    )
    return manifest_path


def _open_archive(path: Path) -> tuple[int, os.stat_result]:
    descriptor: int | None = None
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0),
        )
        metadata = os.fstat(descriptor)
        path_metadata = path.lstat()
    except OSError as error:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        raise BackendSourceError(f"cannot open backend source archive: {path}") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(path_metadata.st_mode)
        or getattr(path_metadata, "st_file_attributes", 0) & 0x400
        or metadata.st_nlink != 1
        or metadata.st_size <= 0
        or metadata.st_size > MAX_ARCHIVE_BYTES
    ):
        os.close(descriptor)
        raise BackendSourceError("backend source archive is not one bounded regular file")
    return descriptor, metadata


def _validate_manifest(value: Mapping[str, Any], archive: Path) -> tuple[dict[str, Any], dict[str, dict[str, Any]], dict[str, Any]]:
    required = {
        "schema", "capture_id", "source_mode", "source_root", "resolved_commit", "source_digest",
        "backend_source_sha256", "source_snapshot_sha256", "native_source_identity", "source_manifest",
        "source_manifest_sha256", "archive_filename", "archive_sha256", "archive_bytes", "created_at",
    }
    if set(value) != required or value.get("schema") != ARCHIVE_MANIFEST_SCHEMA:
        raise BackendSourceError("direct backend source manifest fields/schema mismatch")
    if not isinstance(value.get("capture_id"), str) or not CAPTURE_ID_RE.fullmatch(value["capture_id"]):
        raise BackendSourceError("capture_id is missing")
    if not isinstance(value.get("source_root"), str) or not value["source_root"]:
        raise BackendSourceError("source_root is missing")
    if not isinstance(value.get("created_at"), str) or not value["created_at"]:
        raise BackendSourceError("created_at is missing")
    mode = value.get("source_mode")
    if mode not in {"commit", "snapshot"}:
        raise BackendSourceError("source_mode is invalid")
    resolved = _sha256(value.get("resolved_commit"), "resolved_commit", length=40)
    source_manifest, files = _validate_source_manifest(value.get("source_manifest"))
    if source_manifest["source_mode"] != mode or source_manifest["resolved_commit"] != resolved:
        raise BackendSourceError("top-level source identity differs from source manifest")
    source_digest = _sha256(value.get("source_digest"), "source_digest")
    if source_digest != source_manifest["source_digest"] or value.get("backend_source_sha256") != source_digest:
        raise BackendSourceError("backend source digest does not match source manifest")
    native = _validate_native_identity(value.get("native_source_identity"), resolved)
    if value.get("source_snapshot_sha256") != native["source_snapshot_sha256"]:
        raise BackendSourceError("source snapshot digest does not match native identity")
    if value.get("source_manifest_sha256") != _sha256_bytes(_canonical_bytes(source_manifest)):
        raise BackendSourceError("source manifest digest is invalid")
    if not isinstance(value.get("archive_filename"), str) or value["archive_filename"] != archive.name:
        raise BackendSourceError("archive filename does not match the supplied archive")
    archive_bytes = value.get("archive_bytes")
    if isinstance(archive_bytes, bool) or not isinstance(archive_bytes, int) or archive_bytes <= 0 or archive_bytes > MAX_ARCHIVE_BYTES:
        raise BackendSourceError("archive byte count is invalid")
    _sha256(value.get("archive_sha256"), "archive_sha256")
    return dict(value), files, native


def _member_bytes(tar: tarfile.TarFile, member: tarfile.TarInfo, maximum: int) -> bytes:
    stream = tar.extractfile(member)
    if stream is None:
        raise BackendSourceError(f"archive member cannot be read: {member.name}")
    data = stream.read(maximum + 1)
    if len(data) != member.size or len(data) > maximum:
        raise BackendSourceError(f"archive member size is invalid: {member.name}")
    return data


def _verify_tar_contents(
    stream: BinaryIO,
    checked_manifest: Mapping[str, Any],
    files: Mapping[str, Mapping[str, Any]],
) -> None:
    """Validate the complete tar member set and every declared file digest."""

    stream.seek(0)
    with tarfile.open(fileobj=stream, mode="r:") as tar:
        members = tar.getmembers()
        if len(members) > MAX_MEMBERS:
            raise BackendSourceError("backend source archive has too many members")
        by_name: dict[str, tarfile.TarInfo] = {}
        for member in members:
            name = _safe_member_name(member.name)
            if name in by_name:
                raise BackendSourceError(f"duplicate archive member: {name}")
            if (
                member.type not in {tarfile.REGTYPE, tarfile.AREGTYPE}
                or not member.isreg()
                or member.linkname
                or member.size < 0
                or member.size > MAX_FILE_BYTES
                or member.mode & 0o7000
            ):
                raise BackendSourceError(f"archive member is not a plain regular file: {name}")
            by_name[name] = member
        expected_names = set(files) | {EMBEDDED_MANIFEST_FILENAME}
        if set(by_name) != expected_names:
            missing = sorted(expected_names - set(by_name))
            extra = sorted(set(by_name) - expected_names)
            raise BackendSourceError(f"archive member set differs (missing={missing[:1]}, extra={extra[:1]})")
        embedded = _member_bytes(tar, by_name[EMBEDDED_MANIFEST_FILENAME], MAX_MANIFEST_BYTES)
        if embedded != _canonical_bytes(checked_manifest["source_manifest"]):
            raise BackendSourceError("embedded source manifest differs from external manifest")
        for name, entry in files.items():
            member = by_name[name]
            if member.size != entry["size"]:
                raise BackendSourceError(f"archive size differs from source manifest: {name}")
            stream_in = tar.extractfile(member)
            if stream_in is None:
                raise BackendSourceError(f"archive member cannot be read: {name}")
            digest = hashlib.sha256()
            total = 0
            for chunk in iter(lambda: stream_in.read(1024 * 1024), b""):
                total += len(chunk)
                if total > MAX_FILE_BYTES:
                    raise BackendSourceError(f"archive member exceeds the file limit: {name}")
                digest.update(chunk)
            if total != entry["size"] or digest.hexdigest() != entry["sha256"]:
                raise BackendSourceError(f"archive content digest differs from source manifest: {name}")


def _checked_destination(value: Path) -> tuple[Path, Path]:
    destination = Path(value)
    if not destination.is_absolute() or destination.exists() or destination.is_symlink():
        raise BackendSourceError("frozen source destination must be an absent absolute path")
    parent = destination.parent
    if not parent.is_dir():
        raise BackendSourceError("frozen source destination parent must already exist")
    for ancestor in (parent, *parent.parents):
        try:
            metadata = ancestor.lstat()
        except OSError as error:
            raise BackendSourceError("cannot inspect frozen source destination parent") from error
        if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
            raise BackendSourceError("frozen source destination traverses a link/reparse point")
    return destination, parent


def _make_readonly(root: Path) -> None:
    for current, directories, filenames in os.walk(root, topdown=False, followlinks=False):
        current_path = Path(current)
        for name in filenames:
            path = current_path / name
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise BackendSourceError(f"extracted source contains an unsafe file: {path}")
            path.chmod(0o444 if not (metadata.st_mode & stat.S_IXUSR) else 0o555)
        for name in directories:
            path = current_path / name
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode) or getattr(metadata, "st_file_attributes", 0) & 0x400:
                raise BackendSourceError(f"extracted source contains an unsafe directory: {path}")
            path.chmod(0o555)
    root.chmod(0o555)


def extract_frozen_source(archive_path: Path, manifest_path: Path, destination: Path) -> dict[str, Any]:
    """Verify and atomically extract one direct-Compose backend source archive."""

    archive = Path(archive_path)
    manifest_file = Path(manifest_path)
    manifest = _read_regular_json(manifest_file)
    destination, parent = _checked_destination(Path(destination))
    checked_manifest, files, native = _validate_manifest(manifest, archive)
    descriptor, archive_metadata = _open_archive(archive)
    temporary: Path | None = None
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            digest = _sha256_file_stream(stream, archive_metadata.st_size)
            if digest != checked_manifest["archive_sha256"] or archive_metadata.st_size != checked_manifest["archive_bytes"]:
                raise BackendSourceError("backend source archive digest/size mismatch")
            stream.seek(0)
            try:
                with tarfile.open(fileobj=stream, mode="r:") as tar:
                    members = tar.getmembers()
                    if len(members) > MAX_MEMBERS:
                        raise BackendSourceError("backend source archive has too many members")
                    by_name: dict[str, tarfile.TarInfo] = {}
                    for member in members:
                        name = _safe_member_name(member.name)
                        if name in by_name:
                            raise BackendSourceError(f"duplicate archive member: {name}")
                        if (
                            member.type not in {tarfile.REGTYPE, tarfile.AREGTYPE}
                            or not member.isreg()
                            or member.linkname
                            or member.size < 0
                            or member.size > MAX_FILE_BYTES
                            or member.mode & 0o7000
                        ):
                            raise BackendSourceError(f"archive member is not a plain regular file: {name}")
                        by_name[name] = member
                    expected_names = set(files) | {EMBEDDED_MANIFEST_FILENAME}
                    if set(by_name) != expected_names:
                        missing = sorted(expected_names - set(by_name))
                        extra = sorted(set(by_name) - expected_names)
                        raise BackendSourceError(f"archive member set differs (missing={missing[:1]}, extra={extra[:1]})")
                    embedded = _member_bytes(tar, by_name[EMBEDDED_MANIFEST_FILENAME], MAX_MANIFEST_BYTES)
                    if embedded != _canonical_bytes(checked_manifest["source_manifest"]):
                        raise BackendSourceError("embedded source manifest differs from external manifest")
                    temporary = Path(tempfile.mkdtemp(prefix=f".{destination.name}.extract-", dir=parent))
                    for name, entry in files.items():
                        member = by_name[name]
                        if member.size != entry["size"]:
                            raise BackendSourceError(f"archive size differs from source manifest: {name}")
                        stream_in = tar.extractfile(member)
                        if stream_in is None:
                            raise BackendSourceError(f"archive member cannot be extracted: {name}")
                        target = temporary / Path(*PurePosixPath(name).parts)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        if target.exists() or target.is_symlink():
                            raise BackendSourceError(f"duplicate extracted path: {name}")
                        digest_file = hashlib.sha256()
                        total = 0
                        with target.open("xb") as output:
                            for chunk in iter(lambda: stream_in.read(1024 * 1024), b""):
                                total += len(chunk)
                                if total > MAX_FILE_BYTES:
                                    raise BackendSourceError(f"archive member exceeds the file limit: {name}")
                                digest_file.update(chunk)
                                output.write(chunk)
                            output.flush()
                            os.fsync(output.fileno())
                        if total != entry["size"] or digest_file.hexdigest() != entry["sha256"]:
                            raise BackendSourceError(f"archive content digest differs from source manifest: {name}")
                        target.chmod(0o755 if entry["mode"] == "100755" else 0o644)
            finally:
                # The descriptor remains owned by this function; tarfile does
                # not close the externally supplied file object on all Python
                # versions, so close it explicitly below as well.
                pass
        after = os.fstat(descriptor)
        if (archive_metadata.st_dev, archive_metadata.st_ino, archive_metadata.st_size, archive_metadata.st_mtime_ns, archive_metadata.st_ctime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns
        ):
            raise BackendSourceError("backend source archive changed during extraction")
        if temporary is None:
            raise BackendSourceError("backend source extraction produced no temporary directory")
        _make_readonly(temporary)
        os.replace(temporary, destination)
        temporary = None
        return {
            "schema": ARCHIVE_MANIFEST_SCHEMA,
            "state": "extracted",
            "destination": str(destination),
            "archive_sha256": checked_manifest["archive_sha256"],
            "archive_bytes": checked_manifest["archive_bytes"],
            "source_digest": checked_manifest["source_digest"],
            "backend_source_sha256": checked_manifest["backend_source_sha256"],
            "source_snapshot_sha256": native["source_snapshot_sha256"],
            "resolved_commit": checked_manifest["resolved_commit"],
            "file_count": len(files),
        }
    except BackendSourceError:
        raise
    except (OSError, tarfile.TarError, ValueError) as error:
        raise BackendSourceError("backend source archive extraction failed") from error
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
        if temporary is not None:
            shutil.rmtree(temporary, ignore_errors=True)


def verify_frozen_source_archive(archive_path: Path, manifest_path: Path) -> dict[str, Any]:
    """Verify archive/manifest identity without creating a source directory."""

    archive = Path(archive_path)
    manifest = _read_regular_json(Path(manifest_path))
    checked, files, native = _validate_manifest(manifest, archive)
    descriptor, metadata = _open_archive(archive)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            digest = _sha256_file_stream(stream, metadata.st_size)
        if digest != checked["archive_sha256"] or metadata.st_size != checked["archive_bytes"]:
            raise BackendSourceError("backend source archive digest/size mismatch")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            _verify_tar_contents(stream, checked, files)
        after = os.fstat(descriptor)
        if (
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns,
        ) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise BackendSourceError("backend source archive changed while being verified")
        return {
            "schema": ARCHIVE_MANIFEST_SCHEMA,
            "state": "verified",
            "archive_sha256": digest,
            "archive_bytes": metadata.st_size,
            "source_digest": checked["source_digest"],
            "source_snapshot_sha256": native["source_snapshot_sha256"],
            "resolved_commit": checked["resolved_commit"],
            "file_count": len(files),
        }
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    verify = subparsers.add_parser("verify")
    verify.add_argument("--archive", required=True, type=Path)
    verify.add_argument("--manifest", required=True, type=Path)
    extract = subparsers.add_parser("extract")
    extract.add_argument("--archive", required=True, type=Path)
    extract.add_argument("--manifest", required=True, type=Path)
    extract.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "verify":
        result = verify_frozen_source_archive(args.archive, args.manifest)
    else:
        result = extract_frozen_source(args.archive, args.manifest, args.destination)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BackendSourceError as error:
        print(f"backend source boundary failed: {error}", file=os.sys.stderr)
        raise SystemExit(2)
