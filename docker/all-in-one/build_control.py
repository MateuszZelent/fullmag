"""Bounded stdlib-only RPC helper for the Docker build-control volume."""

from __future__ import annotations

import base64
import binascii
import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from typing import Any, Iterator, Mapping


SCHEMA = "fullmag.docker-build-control.v1"
OWNER_SCHEMA = "fullmag.docker-build-control-owner.v1"
REQUEST_SCHEMA = "fullmag.docker-build-control-request.v1"
RESPONSE_SCHEMA = "fullmag.docker-build-control-response.v1"
VOLUME_PREFIX = "fullmag-build-control-v1-"
CONTROL_ROOT = "/control"
OWNER_FILE = ".fullmag-build-control-owner.json"
OWNER_TEMP_FILE = ".fullmag-build-control-owner-tmp-pending"
OWNER_TEMP_PREFIX = ".fullmag-build-control-owner-tmp-"
WRITE_TEMP_PREFIX = ".fullmag-build-control-write-tmp-"
ROLE = "control"
OWNER_UID = 65532
OWNER_GID = 65532
MAX_JSON_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_RPC_BYTES = 24 * 1024 * 1024
MAX_CAPACITY_BYTES = (1 << 63) - 1

_PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,254}$")
_WORKTREE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
_VOLUME_RE = re.compile(r"^fullmag-build-control-v1-[0-9a-f]{32}$")
_OWNER_ID_RE = re.compile(r"^[0-9a-f]{64}$")
_CREATION_ID_RE = re.compile(r"^[0-9a-f]{64}$")
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)


class BuildControlError(RuntimeError):
    """A request failed a build-control storage or identity invariant."""


def _reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise BuildControlError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise BuildControlError(f"non-finite JSON number is forbidden: {value}")


def _loads(value: bytes, *, label: str, limit: int) -> Any:
    if len(value) > limit:
        raise BuildControlError(f"{label} exceeds its byte limit")
    try:
        text = value.decode("utf-8", errors="strict")
        return json.loads(text, object_pairs_hook=_reject_duplicates, parse_constant=_reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildControlError(f"{label} is not strict UTF-8 JSON") from error


def _canonical(value: Any, *, limit: int, label: str) -> bytes:
    try:
        result = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeError) as error:
        raise BuildControlError(f"{label} is not canonical JSON data") from error
    if len(result) > limit:
        raise BuildControlError(f"{label} exceeds its byte limit")
    return result


def _identity_from_environment(environment: Mapping[str, str]) -> dict[str, str]:
    schema = environment.get("FULLMAG_BUILD_CONTROL_SCHEMA")
    owner_schema = environment.get("FULLMAG_BUILD_CONTROL_OWNER_SCHEMA")
    project = environment.get("FULLMAG_BUILD_CONTROL_PROJECT")
    worktree_id = environment.get("FULLMAG_BUILD_CONTROL_WORKTREE_ID")
    role = environment.get("FULLMAG_BUILD_CONTROL_ROLE")
    owner_id = environment.get("FULLMAG_BUILD_CONTROL_OWNER_ID")
    creation_id = environment.get("FULLMAG_BUILD_CONTROL_CREATION_ID")
    volume_name = environment.get("FULLMAG_BUILD_CONTROL_VOLUME")
    if schema != SCHEMA or owner_schema != OWNER_SCHEMA or role != ROLE:
        raise BuildControlError("helper environment schema or role is unsupported")
    if not isinstance(project, str) or _PROJECT_RE.fullmatch(project) is None:
        raise BuildControlError("helper environment project is invalid")
    if not isinstance(worktree_id, str) or _WORKTREE_RE.fullmatch(worktree_id) is None:
        raise BuildControlError("helper environment worktree identity is invalid")
    if not isinstance(volume_name, str) or _VOLUME_RE.fullmatch(volume_name) is None:
        raise BuildControlError("helper environment volume name is invalid")
    if not isinstance(owner_id, str) or _OWNER_ID_RE.fullmatch(owner_id) is None:
        raise BuildControlError("helper environment owner identity is invalid")
    if not isinstance(creation_id, str) or _CREATION_ID_RE.fullmatch(creation_id) is None:
        raise BuildControlError("helper environment creation identity is invalid")
    identity_seed = {
        "schema": OWNER_SCHEMA,
        "project": project,
        "worktree_id": worktree_id,
        "role": ROLE,
    }
    canonical_seed = _canonical(identity_seed, limit=4096, label="owner identity")
    expected_owner = hashlib.sha256(canonical_seed).hexdigest()
    expected_volume = VOLUME_PREFIX + hashlib.sha256(
        b"fullmag.build-control.volume.v1\0" + canonical_seed
    ).hexdigest()[:32]
    if owner_id != expected_owner or volume_name != expected_volume:
        raise BuildControlError("helper environment owner and volume identity disagree")
    return {
        "schema": OWNER_SCHEMA,
        "project": project,
        "worktree_id": worktree_id,
        "role": ROLE,
        "owner_id": owner_id,
        "creation_id": creation_id,
        "volume_name": volume_name,
    }


def _safe_parts(value: Any) -> tuple[str, ...]:
    if (not isinstance(value, str) or not value or value.startswith("/")
            or value.endswith("/") or "\\" in value or ":" in value or "\x00" in value):
        raise BuildControlError("path must be a non-empty relative POSIX path")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise BuildControlError("path contains invalid Unicode") from error
    if len(encoded) > 4096:
        raise BuildControlError("path exceeds 4096 bytes")
    parts = tuple(value.split("/"))
    if any(part in {"", ".", ".."} for part in parts):
        raise BuildControlError("path contains traversal or empty components")
    if any(part.startswith(".fullmag-build-control-") for part in parts):
        raise BuildControlError("path addresses reserved build-control metadata")
    if any(len(part.encode("utf-8")) > 255 for part in parts):
        raise BuildControlError("path component exceeds 255 bytes")
    return parts


def _write_all(fd: int, content: bytes) -> None:
    view = memoryview(content)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise BuildControlError("short write in build-control volume")
        view = view[written:]


def _read_bounded(fd: int, limit: int) -> bytes:
    chunks: list[bytes] = []
    remaining = limit + 1
    while remaining:
        chunk = os.read(fd, min(1024 * 1024, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    result = b"".join(chunks)
    if len(result) > limit:
        raise BuildControlError("file exceeds its byte limit")
    return result


class ControlVolume:
    """Operate on an already mounted volume using only descriptor-relative I/O."""

    def __init__(
        self,
        identity: Mapping[str, str],
        *,
        root: str = CONTROL_ROOT,
        uid: int = OWNER_UID,
        gid: int = OWNER_GID,
    ) -> None:
        self.identity = dict(identity)
        self.root = root
        self.uid = uid
        self.gid = gid

    def initialize(self) -> dict[str, Any]:
        if os.geteuid() != 0:
            raise BuildControlError("volume initialization requires the one-shot root helper")
        if self.uid != OWNER_UID or self.gid != OWNER_GID:
            raise BuildControlError("volume owner UID/GID is not the fixed unprivileged identity")
        root_fd = self._open_root()
        try:
            if os.listdir(root_fd):
                raise BuildControlError("new control volume is not empty")
            marker = _canonical(self.identity, limit=64 * 1024, label="owner marker")
            marker_fd = os.open(
                OWNER_TEMP_FILE,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC,
                0o600,
                dir_fd=root_fd,
            )
            try:
                _write_all(marker_fd, marker)
                os.fsync(marker_fd)
                os.fchmod(marker_fd, 0o444)
                os.fchown(marker_fd, self.uid, self.gid)
                os.fsync(marker_fd)
            finally:
                os.close(marker_fd)
            os.replace(OWNER_TEMP_FILE, OWNER_FILE, src_dir_fd=root_fd, dst_dir_fd=root_fd)
            os.fsync(root_fd)
            os.fchmod(root_fd, 0o750)
            os.fchown(root_fd, self.uid, self.gid)
            os.fsync(root_fd)
        finally:
            os.close(root_fd)
        return {
            "owner_id": self.identity["owner_id"],
            "creation_id": self.identity["creation_id"],
            "uid": self.uid,
            "gid": self.gid,
        }

    def verify(self) -> dict[str, Any]:
        with self._locked_root():
            return {
                "owner_id": self.identity["owner_id"],
                "creation_id": self.identity["creation_id"],
                "uid": self.uid,
                "gid": self.gid,
            }

    def capacity(self) -> dict[str, int]:
        """Read mounted-filesystem capacity without accepting a path or allocating."""

        with self._locked_root() as root_fd:
            filesystem = os.fstatvfs(root_fd)
            total = filesystem.f_blocks * filesystem.f_frsize
            available = filesystem.f_bavail * filesystem.f_frsize
            if (type(total) is not int or type(available) is not int
                    or total <= 0 or total > MAX_CAPACITY_BYTES
                    or available < 0 or available > total):
                raise BuildControlError("control volume capacity is outside supported bounds")
            return {"total_bytes": total, "available_bytes": available}

    @contextlib.contextmanager
    def _locked_root(self) -> Iterator[int]:
        root_fd = self._open_root()
        marker_fd: int | None = None
        try:
            self._check_root_owner(root_fd)
            marker_fd = os.open(
                OWNER_FILE,
                os.O_RDONLY | _NOFOLLOW | _CLOEXEC,
                dir_fd=root_fd,
            )
            marker_stat = os.fstat(marker_fd)
            if (not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_nlink != 1
                    or marker_stat.st_uid != self.uid or marker_stat.st_gid != self.gid
                    or stat.S_IMODE(marker_stat.st_mode) != 0o444):
                raise BuildControlError("owner marker type, owner, links, or permissions are invalid")
            fcntl.flock(marker_fd, fcntl.LOCK_EX)
            marker = _loads(_read_bounded(marker_fd, 64 * 1024), label="owner marker", limit=64 * 1024)
            if marker != self.identity:
                raise BuildControlError("owner marker does not match the expected project/worktree")
            yield root_fd
        finally:
            if marker_fd is not None:
                try:
                    fcntl.flock(marker_fd, fcntl.LOCK_UN)
                finally:
                    os.close(marker_fd)
            os.close(root_fd)

    def _open_root(self) -> int:
        try:
            fd = os.open(self.root, os.O_RDONLY | _DIRECTORY | _NOFOLLOW | _CLOEXEC)
        except OSError as error:
            raise BuildControlError("mounted control root is unavailable or not a real directory") from error
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            os.close(fd)
            raise BuildControlError("mounted control root is not a directory")
        return fd

    def _check_root_owner(self, root_fd: int) -> None:
        root_stat = os.fstat(root_fd)
        if (root_stat.st_uid != self.uid or root_stat.st_gid != self.gid
                or stat.S_IMODE(root_stat.st_mode) != 0o750):
            raise BuildControlError("control root ownership or permissions do not match the marker")

    def _open_parent(self, root_fd: int, parts: tuple[str, ...], *, create: bool) -> tuple[int, str]:
        cursor = os.dup(root_fd)
        try:
            for part in parts[:-1]:
                try:
                    next_fd = os.open(
                        part,
                        os.O_RDONLY | _DIRECTORY | _NOFOLLOW | _CLOEXEC,
                        dir_fd=cursor,
                    )
                except FileNotFoundError:
                    if not create:
                        raise
                    try:
                        os.mkdir(part, 0o750, dir_fd=cursor)
                    except FileExistsError:
                        pass
                    os.fsync(cursor)
                    next_fd = os.open(
                        part,
                        os.O_RDONLY | _DIRECTORY | _NOFOLLOW | _CLOEXEC,
                        dir_fd=cursor,
                    )
                item_stat = os.fstat(next_fd)
                if (not stat.S_ISDIR(item_stat.st_mode) or item_stat.st_uid != self.uid
                        or item_stat.st_gid != self.gid or item_stat.st_mode & 0o002):
                    os.close(next_fd)
                    raise BuildControlError("parent path contains a foreign, writable, or non-directory entry")
                os.close(cursor)
                cursor = next_fd
            return cursor, parts[-1]
        except Exception:
            os.close(cursor)
            raise

    def _read_file(self, root_fd: int, relative_path: str, *, limit: int) -> tuple[bytes, int]:
        parts = _safe_parts(relative_path)
        parent_fd, name = self._open_parent(root_fd, parts, create=False)
        try:
            try:
                fd = os.open(name, os.O_RDONLY | _NOFOLLOW | _CLOEXEC, dir_fd=parent_fd)
            except FileNotFoundError:
                raise
            try:
                item_stat = os.fstat(fd)
                if (not stat.S_ISREG(item_stat.st_mode) or item_stat.st_nlink != 1
                        or item_stat.st_uid != self.uid or item_stat.st_gid != self.gid):
                    raise BuildControlError("requested control file is not a singly-linked owned regular file")
                if item_stat.st_size > limit:
                    raise BuildControlError("requested control file exceeds its byte limit")
                data = _read_bounded(fd, limit)
                return data, len(data)
            finally:
                os.close(fd)
        finally:
            os.close(parent_fd)

    def _write_file(self, root_fd: int, relative_path: str, content: bytes) -> dict[str, Any]:
        if len(content) > MAX_FILE_BYTES:
            raise BuildControlError("requested content exceeds the file-size limit")
        parts = _safe_parts(relative_path)
        parent_fd, name = self._open_parent(root_fd, parts, create=True)
        try:
            try:
                existing = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                existing = None
            if existing is not None and (
                not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1
                or existing.st_uid != self.uid or existing.st_gid != self.gid
            ):
                raise BuildControlError("write target is a link, non-file, or foreign file")
            temporary = WRITE_TEMP_PREFIX + secrets.token_hex(16)
            fd = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC,
                0o640,
                dir_fd=parent_fd,
            )
            try:
                _write_all(fd, content)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(temporary, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            os.fsync(parent_fd)
            written, size = self._read_file(root_fd, relative_path, limit=MAX_FILE_BYTES)
            return {"size_bytes": size, "sha256": hashlib.sha256(written).hexdigest()}
        finally:
            os.close(parent_fd)

    def dispatch(self, operation: str, request: Mapping[str, Any]) -> dict[str, Any]:
        request_identity = {
            "project": self.identity["project"],
            "worktree_id": self.identity["worktree_id"],
            "role": self.identity["role"],
            "owner_id": self.identity["owner_id"],
            "creation_id": self.identity["creation_id"],
            "volume_name": self.identity["volume_name"],
        }
        if (request.get("schema") != REQUEST_SCHEMA or request.get("operation") != operation
                or request.get("identity") != request_identity):
            raise BuildControlError("request identity does not match the expected volume owner")
        if operation == "initialize":
            if set(request) != {"schema", "operation", "identity"}:
                raise BuildControlError("initialize request has unexpected fields")
            return self.initialize()
        if operation not in {"verify", "capacity", "write_json", "read_json", "write_bytes", "read_bytes", "stat"}:
            raise BuildControlError("unsupported build-control operation")
        if operation == "capacity":
            if set(request) != {"schema", "operation", "identity"}:
                raise BuildControlError("capacity request must not include path or payload fields")
            return self.capacity()
        with self._locked_root() as root_fd:
            if operation == "verify":
                if set(request) != {"schema", "operation", "identity"}:
                    raise BuildControlError("verify request has unexpected fields")
                return {
                    "owner_id": self.identity["owner_id"],
                    "creation_id": self.identity["creation_id"],
                    "uid": self.uid,
                    "gid": self.gid,
                }
            relative_path = request.get("relative_path")
            if not isinstance(relative_path, str):
                raise BuildControlError("request has no relative path")
            if operation == "write_json":
                if set(request) != {"schema", "operation", "identity", "relative_path", "document"}:
                    raise BuildControlError("write_json request has unexpected fields")
                content = _canonical(request["document"], limit=MAX_JSON_BYTES, label="JSON document")
                return self._write_file(root_fd, relative_path, content)
            if operation == "read_json":
                if set(request) != {"schema", "operation", "identity", "relative_path"}:
                    raise BuildControlError("read_json request has unexpected fields")
                content, size = self._read_file(root_fd, relative_path, limit=MAX_JSON_BYTES)
                document = _loads(content, label="stored JSON document", limit=MAX_JSON_BYTES)
                return {"document": document, "size_bytes": size, "sha256": hashlib.sha256(content).hexdigest()}
            if operation == "write_bytes":
                if set(request) != {"schema", "operation", "identity", "relative_path", "data_base64"}:
                    raise BuildControlError("write_bytes request has unexpected fields")
                data = request.get("data_base64")
                if not isinstance(data, str) or len(data) > ((MAX_FILE_BYTES + 2) // 3) * 4:
                    raise BuildControlError("binary request is missing or exceeds its encoded size limit")
                try:
                    content = base64.b64decode(data, validate=True)
                except (ValueError, binascii.Error) as error:
                    raise BuildControlError("binary request is not valid base64") from error
                return self._write_file(root_fd, relative_path, content)
            if operation in {"read_bytes", "stat"}:
                if set(request) != {"schema", "operation", "identity", "relative_path"}:
                    raise BuildControlError(f"{operation} request has unexpected fields")
                try:
                    content, size = self._read_file(root_fd, relative_path, limit=MAX_FILE_BYTES)
                except FileNotFoundError:
                    if operation == "stat":
                        return {"exists": False}
                    raise
                result = {
                    "exists": True,
                    "size_bytes": size,
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
                if operation == "read_bytes":
                    result["data_base64"] = base64.b64encode(content).decode("ascii")
                return result
        raise BuildControlError("unsupported build-control operation")


def _request_identity(request: Mapping[str, Any], expected: Mapping[str, str]) -> None:
    if request.get("schema") != REQUEST_SCHEMA or request.get("identity") != {
        "project": expected["project"],
        "worktree_id": expected["worktree_id"],
        "role": expected["role"],
        "owner_id": expected["owner_id"],
        "creation_id": expected["creation_id"],
        "volume_name": expected["volume_name"],
    }:
        raise BuildControlError("request schema or identity does not match the mounted volume")


def main() -> int:
    try:
        expected = _identity_from_environment(os.environ)
        raw = sys.stdin.buffer.read(MAX_RPC_BYTES + 1)
        if len(raw) > MAX_RPC_BYTES:
            raise BuildControlError("RPC request exceeds its byte limit")
        request = _loads(raw, label="RPC request", limit=MAX_RPC_BYTES)
        if not isinstance(request, dict) or not isinstance(request.get("operation"), str):
            raise BuildControlError("RPC request must be an object with an operation")
        _request_identity(request, expected)
        uid = int(os.environ.get("FULLMAG_BUILD_CONTROL_UID", ""))
        gid = int(os.environ.get("FULLMAG_BUILD_CONTROL_GID", ""))
        if uid != OWNER_UID or gid != OWNER_GID:
            raise BuildControlError("helper environment owner UID/GID is unsupported")
        store = ControlVolume(expected, uid=uid, gid=gid)
        operation = request["operation"]
        if operation == "initialize":
            if os.geteuid() != 0 or not _has_chown_capability():
                raise BuildControlError("root initialization requires only the CHOWN capability")
        elif os.geteuid() != uid or os.getegid() != gid:
            raise BuildControlError("normal helper operation must run as UID/GID 65532")
        result = store.dispatch(operation, request)
        response = {
            "schema": RESPONSE_SCHEMA,
            "ok": True,
            "operation": operation,
            "result": result,
        }
        output = _canonical(response, limit=MAX_RPC_BYTES, label="RPC response")
        sys.stdout.buffer.write(output + b"\n")
        sys.stdout.buffer.flush()
        return 0
    except Exception as error:
        message = str(error).replace("\n", " ").replace("\r", " ")[:512]
        sys.stderr.write(f"build-control error: {type(error).__name__}: {message}\n")
        sys.stderr.flush()
        return 2


def _has_chown_capability() -> bool:
    capabilities: dict[str, int] = {}
    try:
        with open("/proc/self/status", "r", encoding="ascii") as status:
            for line in status:
                label, separator, raw = line.partition(":")
                if separator and label in {"CapEff", "CapPrm", "CapBnd", "CapInh", "CapAmb"}:
                    capabilities[label] = int(raw.strip(), 16)
    except (OSError, ValueError):
        return False
    return capabilities == {"CapEff": 1, "CapPrm": 1, "CapBnd": 1, "CapInh": 0, "CapAmb": 0}


if __name__ == "__main__":
    raise SystemExit(main())
