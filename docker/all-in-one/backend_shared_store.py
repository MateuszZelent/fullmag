"""Content-addressed DEV packages shared by cooperating local Compose groups.

Only sealed regular artifact files are hardlinked. Receipts, candidates, Cargo
targets and runtime state remain private. All links use one volume-root mount:
Linux rejects hardlinks across bind-mount aliases even on the same filesystem.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import time
import uuid

SCHEMA = "fullmag.shared-backend-package.v1"
ROOT = Path("/opt/fullmag/shared-backend")
HEX = re.compile(r"[a-f0-9]{64}")


class StoreError(RuntimeError):
    pass


class StoreBusy(StoreError):
    """A live claim currently prevents maintenance."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def key_for(identity):
    return hashlib.sha256(canonical({"schema": SCHEMA, "inputs": identity})).hexdigest()


def safe_path(path, *, directory=False):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise StoreError("shared cache path must be absolute without traversal")
    for item in (*reversed(path.parents), path):
        metadata = item.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise StoreError(f"shared cache path contains a link: {item}")
    metadata = path.lstat()
    if directory and not stat.S_ISDIR(metadata.st_mode):
        raise StoreError(f"shared cache path is not a directory: {path}")
    if not directory and not stat.S_ISREG(metadata.st_mode):
        raise StoreError(f"shared cache path is not a regular file: {path}")
    return metadata


def mkdir(path):
    safe_path(path.parent, directory=True)
    path.mkdir(mode=0o750, exist_ok=True)
    safe_path(path, directory=True)


def fsync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def locked(path, *, exclusive=True, timeout=3600):
    safe_path(path.parent, directory=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise StoreError("shared cache lock is not one regular file")
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(descriptor, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise StoreBusy("shared cache is busy; lock wait expired")
                time.sleep(min(0.2, max(0, deadline - time.monotonic())))
        yield
    finally:
        # Lock files are never removed: unlinking permits two distinct locks.
        os.close(descriptor)


def _relative(value):
    if not isinstance(value, str):
        raise StoreError("artifact path is not text")
    path = PurePosixPath(value)
    if (not value or path.is_absolute() or ".." in path.parts or "\\" in value
            or value != path.as_posix() or value in {".", "manifest.json"}):
        raise StoreError("artifact path escapes its package")
    return path


def _verify(path, record, *, sealed):
    before = safe_path(path)
    if (record.get("mode") not in {"100644", "100755"}
            or type(record.get("size")) is not int or record["size"] < 0
            or not isinstance(record.get("sha256"), str)
            or HEX.fullmatch(record["sha256"]) is None):
        raise StoreError("artifact record is malformed")
    if sealed and before.st_mode & 0o222:
        raise StoreError("shared artifact is writable")
    if bool(before.st_mode & 0o111) != (record["mode"] == "100755"):
        raise StoreError("artifact execute mode differs")
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    # Other groups may remove a hardlink while this sealed payload is hashed.
    # Mode+mtime+content remain binding; link-count ctime is not a byte change.
    signature = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
                              item.st_mode if sealed else item.st_ctime_ns)
    if (signature(before) != signature(after) or before.st_size != record["size"]
            or digest.hexdigest() != record["sha256"]):
        raise StoreError("shared artifact changed or failed its content hash")


class Store:
    def __init__(self, root=ROOT):
        self.root = Path(root)
        safe_path(self.root, directory=True)
        for name in ("artifacts", "locks", "staging"):
            mkdir(self.root / name)

    @contextmanager
    def claim(self, identity, *, timeout=3600):
        key = key_for(identity)
        # GC cannot race a publisher or unlink an entry while it is linked.
        # Different build keys proceed concurrently; identical ones build once.
        with locked(self.root / ".gc.lock", exclusive=False, timeout=timeout):
            with locked(self.root / "locks" / key, timeout=timeout):
                yield Entry(self, key, identity)

    def private_alias(self, package, candidate, group):
        if not re.fullmatch(r"groups/[a-f0-9]{64}", group):
            raise StoreError("shared package group is not a cache unit")
        try:
            relative = candidate.relative_to(package)
        except ValueError as error:
            raise StoreError("candidate is outside the private package") from error
        target = self.root / group / relative
        first = safe_path(candidate, directory=True)
        second = safe_path(target, directory=True)
        if (first.st_dev, first.st_ino) != (second.st_dev, second.st_ino):
            raise StoreError("package and shared-volume aliases differ")
        return target

    def collect(self, *, max_entries=8, max_bytes=64 * 1024**3):
        if max_entries < 0 or max_bytes < 0:
            raise StoreError("cache limits must be nonnegative")
        removed = []
        # Explicit maintenance only. A busy build causes no partial cleanup.
        with locked(self.root / ".gc.lock", timeout=0):
            entries = []
            for path in (self.root / "artifacts").iterdir():
                if HEX.fullmatch(path.name) is None:
                    raise StoreError("unknown shared package entry; retained")
                manifest = Entry(self, path.name).read()
                entries.append((path.stat().st_mtime_ns, path, sum(r["size"] for r in manifest["receipt"]["artifacts"])))
            total = sum(item[2] for item in entries)
            entries.sort(key=lambda item: (item[0], item[1].name))
            while entries and (len(entries) > max_entries or total > max_bytes):
                _, path, size = entries.pop(0)
                # Group current/rollback hardlinks remain valid after eviction;
                # disk blocks disappear only when the final link is removed.
                # Remove the key atomically before unlinking payload. A crash
                # during rmtree must never expose a partially-deleted entry.
                retired = self.root / "staging" / ("evicted-" + path.name + "-" + uuid.uuid4().hex)
                os.rename(path, retired)
                fsync_dir(path.parent)
                fsync_dir(retired.parent)
                shutil.rmtree(retired)
                fsync_dir(retired.parent)
                removed.append(path.name)
                total -= size
            fsync_dir(self.root / "artifacts")
        return {"schema": SCHEMA, "evicted": removed, "cache_logical_bytes": total,
                "staging_retained": sorted(path.name for path in (self.root / "staging").iterdir())}


class Entry:
    def __init__(self, store, key, identity=None):
        if HEX.fullmatch(key) is None:
            raise StoreError("invalid shared package key")
        self.store, self.key, self.identity = store, key, identity
        self.path = store.root / "artifacts" / key

    def read(self):
        if not self.path.exists() and not self.path.is_symlink():
            return None
        safe_path(self.path, directory=True)
        manifest_path = self.path / "manifest.json"
        metadata = safe_path(manifest_path)
        if metadata.st_size > 8 * 1024**2 or metadata.st_nlink != 1:
            raise StoreError("invalid shared package manifest")
        value = json.loads(manifest_path.read_bytes())
        if (value.get("schema") != SCHEMA or value.get("key") != self.key
                or key_for(value.get("inputs")) != self.key
                or (self.identity is not None and value["inputs"] != self.identity)):
            raise StoreError("shared package identity differs")
        receipt = value.get("receipt")
        if not isinstance(receipt, dict) or receipt.get("state") != "succeeded":
            raise StoreError("shared package receipt is not successful")
        records = receipt.get("artifacts")
        if not isinstance(records, list) or not records:
            raise StoreError("shared package has no artifact inventory")
        expected = {"manifest.json"}
        for record in records:
            relative = _relative(record.get("path"))
            if str(relative) in expected:
                raise StoreError("duplicate shared artifact")
            expected.add(str(relative))
            _verify(self.path / relative, record, sealed=True)
        actual = set()
        expected_dirs = {str(p) for name in expected for p in PurePosixPath(name).parents if str(p) != "."}
        actual_dirs = set()
        for base, directories, files in os.walk(self.path, followlinks=False):
            for name in directories:
                item = Path(base) / name
                safe_path(item, directory=True)
                actual_dirs.add(item.relative_to(self.path).as_posix())
            for name in files:
                item = Path(base) / name
                safe_path(item)
                actual.add(item.relative_to(self.path).as_posix())
        if actual != expected or actual_dirs != expected_dirs:
            raise StoreError("shared package has an unrecorded inventory")
        return value

    def restore(self, candidate, manifest):
        safe_path(candidate, directory=True)
        created = []
        try:
            for record in manifest["receipt"]["artifacts"]:
                relative = _relative(record["path"])
                target = candidate / relative
                for parent in reversed(target.parents):
                    if parent != candidate and candidate in parent.parents:
                        mkdir(parent)
                # Both paths use the same volume-root mount, never aliases.
                os.link(self.path / relative, target, follow_symlinks=False)
                created.append(target)
            for directory in {path.parent for path in created}:
                fsync_dir(directory)
            fsync_dir(candidate)
        except Exception:
            for path in reversed(created):
                path.unlink()
            raise

    def publish(self, candidate, receipt):
        if self.read() is not None:
            raise StoreError("shared package already published")
        stage = Path(tempfile.mkdtemp(prefix=self.key + "-", dir=self.store.root / "staging"))
        try:
            for record in receipt["artifacts"]:
                relative = _relative(record["path"])
                source = candidate / relative
                _verify(source, record, sealed=False)
                target = stage / relative
                for parent in reversed(target.parents):
                    if parent != stage and stage in parent.parents:
                        mkdir(parent)
                os.chmod(source, 0o555 if record["mode"] == "100755" else 0o444)
                os.link(source, target, follow_symlinks=False)
                descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            manifest = {"schema": SCHEMA, "key": self.key, "inputs": self.identity, "receipt": receipt}
            with (stage / "manifest.json").open("xb") as stream:
                stream.write(canonical(manifest))
                stream.flush()
                os.fsync(stream.fileno())
            for base, _, _ in os.walk(stage, topdown=False):
                fsync_dir(Path(base))
            os.rename(stage, self.path)
            fsync_dir(self.path.parent)
            fsync_dir(self.store.root / "staging")
        finally:
            if stage.exists():
                shutil.rmtree(stage)
