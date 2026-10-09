"""Verified, immutable source-content storage for runner capsules.

Capsule files may be hard links to this store. Objects are copied into the
store from a private capture stage, published with an atomic create-if-absent
hard link, verified before use, and made read-only. Store objects are never
linked from a live checkout or from an execution workspace.
"""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import stat
import tempfile
from typing import Iterator

from .source_store_lock import (
    OwnerIdentityProvider,
    SourceStoreLockError,
    ensure_publication_process_is_safe as _ensure_lock_process_is_safe,
    publication_lock as _complete_owner_publication_lock,
    publication_process_is_safe as _lock_process_is_safe,
)


_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
_MODES = frozenset({"100644", "100755"})
_READONLY_ATTRIBUTE = 0x1
_LOCK_WAIT_SECONDS = 30.0
_CHUNK_SIZE = 1024 * 1024


class SourceContentStoreError(ValueError):
    """A content object cannot be trusted or linked into a capsule."""


def _identity(metadata: os.stat_result) -> tuple[int, int]:
    return metadata.st_dev, metadata.st_ino


def _is_reparse(metadata: os.stat_result) -> bool:
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & 0x400
    )


def _guard_path(path: Path, label: str, *, allow_missing: bool) -> None:
    """Reject symlinks and Windows reparse points in every existing component."""

    absolute = Path(os.path.abspath(path))
    anchor = Path(absolute.anchor)
    current = anchor
    for part in absolute.parts[len(anchor.parts) :]:
        current = current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            if allow_missing:
                break
            raise SourceContentStoreError(f"{label} does not exist: {path}")
        except OSError as error:
            raise SourceContentStoreError(f"cannot inspect {label}: {path}") from error
        if _is_reparse(metadata):
            raise SourceContentStoreError(
                f"{label} traverses a symlink or reparse point: {path}"
            )


def _real_directory(path: Path, label: str, *, create: bool) -> Path:
    _guard_path(path, label, allow_missing=create)
    try:
        if create:
            path.mkdir(parents=True, exist_ok=True)
        metadata = path.lstat()
    except OSError as error:
        raise SourceContentStoreError(f"cannot prepare {label}: {path}") from error
    if _is_reparse(metadata) or not stat.S_ISDIR(metadata.st_mode):
        raise SourceContentStoreError(f"{label} is not a real directory: {path}")
    _guard_path(path, label, allow_missing=False)
    return path


def _regular_file(path: Path, label: str) -> os.stat_result:
    _guard_path(path, label, allow_missing=False)
    try:
        metadata = path.lstat()
    except OSError as error:
        raise SourceContentStoreError(f"cannot inspect {label}: {path}") from error
    if _is_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
        raise SourceContentStoreError(f"{label} is not a regular file: {path}")
    return metadata


def _hash_file(path: Path, label: str) -> tuple[int, str, os.stat_result]:
    before = _regular_file(path, label)
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if _identity(opened) != _identity(before) or not stat.S_ISREG(opened.st_mode):
                raise SourceContentStoreError(f"{label} changed while opening: {path}")
            while True:
                chunk = stream.read(_CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
            after_open = os.fstat(stream.fileno())
        after = _regular_file(path, label)
    except SourceContentStoreError:
        raise
    except OSError as error:
        raise SourceContentStoreError(f"cannot read {label}: {path}") from error
    if (
        _identity(before) != _identity(after)
        or _identity(after_open) != _identity(after)
        or before.st_size != after.st_size
        or size != after.st_size
    ):
        raise SourceContentStoreError(f"{label} changed while being verified: {path}")
    return size, digest.hexdigest(), after


def _readonly_mode(mode: str) -> int:
    return 0o555 if mode == "100755" else 0o444


def _is_readonly(path: Path, metadata: os.stat_result) -> bool:
    if os.name == "nt":
        return bool(getattr(metadata, "st_file_attributes", 0) & _READONLY_ATTRIBUTE)
    return stat.S_IMODE(metadata.st_mode) in {0o444, 0o555}


def _same_file(left: Path, right: Path) -> bool:
    try:
        return os.path.samefile(left, right)
    except OSError as error:
        raise SourceContentStoreError("filesystem cannot verify a hard link") from error


class SourceContentStore:
    """Content-addressed file store keyed by SHA-256 and Git executable mode."""

    def __init__(self, root: Path | str):
        candidate = Path(root).expanduser()
        if not candidate.is_absolute():
            candidate = Path.cwd() / candidate
        self.root = Path(os.path.abspath(candidate))
        _guard_path(self.root, "source content store", allow_missing=True)
        self._owner_identity_provider = OwnerIdentityProvider()

    def _object_path(self, digest: str, mode: str) -> Path:
        return self.root / "sha256" / digest[:2] / f"{digest}-{mode}"

    def _prepare_object_parent(self, path: Path) -> None:
        self._assert_publication_process_safe()
        try:
            path.relative_to(self.root)
        except ValueError as error:
            raise SourceContentStoreError("content object escaped its store") from error
        _real_directory(self.root, "source content store", create=True)
        _real_directory(self.root / "sha256", "content object directory", create=True)
        _real_directory(path.parent, "content object directory", create=True)

    @contextmanager
    def _publication_lock(self, object_path: Path) -> Iterator[None]:
        lock_path = object_path.with_name(object_path.name + ".lock")
        try:
            with _complete_owner_publication_lock(
                lock_path,
                self.root,
                wait_timeout_seconds=_LOCK_WAIT_SECONDS,
                identity_provider=self._owner_identity_provider,
            ):
                yield
        except SourceStoreLockError as error:
            raise SourceContentStoreError(str(error)) from error

    @staticmethod
    def _assert_publication_process_safe() -> None:
        try:
            _ensure_lock_process_is_safe()
        except SourceStoreLockError as error:
            raise SourceContentStoreError(str(error)) from error

    def _verify_object(
        self,
        object_path: Path,
        *,
        digest: str,
        mode: str,
        size: int,
    ) -> os.stat_result:
        metadata = _regular_file(object_path, "content object")
        actual_size, actual_digest, metadata = _hash_file(object_path, "content object")
        if actual_size != size or actual_digest != digest:
            raise SourceContentStoreError(
                f"content object digest or size mismatch: {object_path}"
            )
        if not _is_readonly(object_path, metadata):
            raise SourceContentStoreError(f"content object is writable: {object_path}")
        if os.name != "nt" and stat.S_IMODE(metadata.st_mode) != _readonly_mode(mode):
            raise SourceContentStoreError(
                f"content object mode does not match its key: {object_path}"
            )
        return metadata

    def _copy_to_temporary(
        self,
        source: Path,
        temporary: Path,
        *,
        digest: str,
        size: int,
    ) -> None:
        source_metadata = _regular_file(source, "capture-stage file")
        copied_digest = hashlib.sha256()
        copied_size = 0
        try:
            with source.open("rb") as input_stream, temporary.open("wb") as output_stream:
                opened = os.fstat(input_stream.fileno())
                if _identity(opened) != _identity(source_metadata):
                    raise SourceContentStoreError(
                        f"capture-stage file changed while opening: {source}"
                    )
                while True:
                    chunk = input_stream.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    output_stream.write(chunk)
                    copied_digest.update(chunk)
                    copied_size += len(chunk)
                after = os.fstat(input_stream.fileno())
                output_stream.flush()
                os.fsync(output_stream.fileno())
            final_source = _regular_file(source, "capture-stage file")
        except SourceContentStoreError:
            raise
        except OSError as error:
            errno_detail = f", errno={error.errno}" if error.errno is not None else ""
            detail = error.strerror or str(error)
            raise SourceContentStoreError(
                f"cannot copy capture-stage file into content store: {source} "
                f"({type(error).__name__}{errno_detail}: {detail})"
            ) from error
        if (
            _identity(source_metadata) != _identity(after)
            or _identity(after) != _identity(final_source)
            or source_metadata.st_size != final_source.st_size
            or copied_size != size
            or copied_digest.hexdigest() != digest
        ):
            raise SourceContentStoreError(
                f"capture-stage file changed or mismatched its digest: {source}"
            )

    def _remove_published_object(
        self,
        object_path: Path,
        expected_identity: tuple[int, int],
    ) -> None:
        if not _lock_process_is_safe():
            return
        try:
            self._assert_publication_process_safe()
            metadata = _regular_file(object_path, "content object")
            if _identity(metadata) != expected_identity:
                return
            if os.name == "nt":
                self._assert_publication_process_safe()
                object_path.chmod(0o666)
            self._assert_publication_process_safe()
            object_path.unlink()
        except SourceContentStoreError:
            if not _lock_process_is_safe():
                return
            raise
        except FileNotFoundError:
            return
        except OSError:
            # A leftover object is rejected on the next use unless it is
            # complete and sealed. Never replace or repair it implicitly.
            return

    def _ensure_object(
        self,
        source: Path,
        *,
        digest: str,
        mode: str,
        size: int,
    ) -> Path:
        object_path = self._object_path(digest, mode)
        self._prepare_object_parent(object_path)
        with self._publication_lock(object_path):
            self._assert_publication_process_safe()
            _guard_path(object_path, "content object", allow_missing=True)
            if os.path.lexists(object_path):
                self._verify_object(
                    object_path,
                    digest=digest,
                    mode=mode,
                    size=size,
                )
                self._assert_publication_process_safe()
                return object_path

            descriptor: int | None = None
            temporary: Path | None = None
            published_identity: tuple[int, int] | None = None
            try:
                self._assert_publication_process_safe()
                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=f".pending-{digest}-{mode}-",
                    dir=object_path.parent,
                )
                os.close(descriptor)
                descriptor = None
                temporary = Path(temporary_name)
                self._assert_publication_process_safe()
                self._copy_to_temporary(
                    source,
                    temporary,
                    digest=digest,
                    size=size,
                )
                self._assert_publication_process_safe()
                try:
                    os.link(temporary, object_path, follow_symlinks=False)
                except FileExistsError:
                    self._verify_object(
                        object_path,
                        digest=digest,
                        mode=mode,
                        size=size,
                    )
                    self._assert_publication_process_safe()
                    return object_path
                except OSError as error:
                    raise SourceContentStoreError(
                        f"atomic content object publication failed: {object_path}"
                    ) from error

                self._assert_publication_process_safe()
                metadata = _regular_file(object_path, "published content object")
                published_identity = _identity(metadata)
                self._assert_publication_process_safe()
                temporary.unlink()
                temporary = None
                self._assert_publication_process_safe()
                object_path.chmod(_readonly_mode(mode))
                self._verify_object(
                    object_path,
                    digest=digest,
                    mode=mode,
                    size=size,
                )
                if os.name != "nt":
                    try:
                        directory_fd = os.open(object_path.parent, os.O_RDONLY)
                        try:
                            os.fsync(directory_fd)
                        finally:
                            os.close(directory_fd)
                    except OSError as error:
                        raise SourceContentStoreError(
                            f"cannot sync content object directory: {object_path.parent}"
                        ) from error
                self._assert_publication_process_safe()
                return object_path
            except SourceContentStoreError:
                if published_identity is not None:
                    self._remove_published_object(object_path, published_identity)
                raise
            except OSError as error:
                if published_identity is not None:
                    self._remove_published_object(object_path, published_identity)
                raise SourceContentStoreError(
                    f"content object publication failed: {object_path}"
                ) from error
            finally:
                if descriptor is not None:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
                if temporary is not None:
                    try:
                        self._assert_publication_process_safe()
                        temporary.unlink()
                    except SourceContentStoreError:
                        # A forked child must leave inherited temporary state alone.
                        pass
                    except FileNotFoundError:
                        pass
                    except OSError:
                        pass

    def link_file(
        self,
        source: Path | str,
        destination: Path | str,
        *,
        digest: str,
        mode: str,
        size: int,
    ) -> None:
        """Replace a verified private-stage file with a hard link to its CAS object."""

        if not isinstance(digest, str) or not _DIGEST_RE.fullmatch(digest):
            raise SourceContentStoreError("content object digest must be lowercase SHA-256")
        if mode not in _MODES:
            raise SourceContentStoreError(f"unsupported content object mode: {mode!r}")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise SourceContentStoreError("content object size must be a non-negative integer")

        source_path = Path(source)
        destination_path = Path(destination)
        source_size, source_digest, source_metadata = _hash_file(
            source_path,
            "capture-stage file",
        )
        if source_size != size or source_digest != digest:
            raise SourceContentStoreError(
                f"capture-stage file does not match its manifest: {source_path}"
            )
        if os.name != "nt":
            expected_executable = mode == "100755"
            actual_executable = bool(source_metadata.st_mode & stat.S_IXUSR)
            if actual_executable != expected_executable:
                raise SourceContentStoreError(
                    f"capture-stage mode does not match its manifest: {source_path}"
                )

        object_path = self._ensure_object(
            source_path,
            digest=digest,
            mode=mode,
            size=size,
        )
        _guard_path(destination_path, "capsule stage file", allow_missing=False)
        _real_directory(destination_path.parent, "capsule stage directory", create=False)
        try:
            object_metadata = _regular_file(object_path, "content object")
            destination_metadata = _regular_file(destination_path, "capsule stage file")
            parent_device = destination_path.parent.stat().st_dev
        except OSError as error:
            raise SourceContentStoreError("cannot inspect hard-link endpoints") from error
        if object_metadata.st_dev != parent_device or destination_metadata.st_dev != parent_device:
            raise SourceContentStoreError(
                "content store and capsule stage are not on the same filesystem"
            )

        try:
            destination_path.unlink()
            os.link(object_path, destination_path, follow_symlinks=False)
        except OSError as error:
            raise SourceContentStoreError(
                f"cannot hard-link capsule file to verified content object: {destination_path}"
            ) from error

        linked_metadata = _regular_file(destination_path, "linked capsule file")
        if not _same_file(object_path, destination_path):
            raise SourceContentStoreError(
                f"capsule file is not linked to its content object: {destination_path}"
            )
        if _identity(linked_metadata) != _identity(object_metadata):
            raise SourceContentStoreError(
                f"capsule hard link identity mismatch: {destination_path}"
            )

    def unlink_stage_link(
        self,
        path: Path | str,
        *,
        digest: str,
        mode: str,
        size: int,
    ) -> bool:
        """Remove this capture stage's link, resealing the shared object on Windows."""

        if not isinstance(digest, str) or not _DIGEST_RE.fullmatch(digest):
            raise SourceContentStoreError("content object digest must be lowercase SHA-256")
        if mode not in _MODES:
            raise SourceContentStoreError(f"unsupported content object mode: {mode!r}")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise SourceContentStoreError("content object size must be a non-negative integer")

        stage_path = Path(path)
        object_path = self._object_path(digest, mode)
        if not os.path.lexists(object_path):
            return False
        try:
            with self._publication_lock(object_path):
                self._assert_publication_process_safe()
                if not os.path.lexists(object_path):
                    return False
                object_metadata = self._verify_object(
                    object_path,
                    digest=digest,
                    mode=mode,
                    size=size,
                )
                stage_metadata = _regular_file(stage_path, "capture-stage file")
                if not _same_file(object_path, stage_path):
                    return False
                if _identity(stage_metadata) != _identity(object_metadata):
                    raise SourceContentStoreError(
                        f"capture-stage hard link identity mismatch: {stage_path}"
                    )

                if os.name == "nt":
                    self._assert_publication_process_safe()
                    object_path.chmod(0o666)
                    try:
                        self._assert_publication_process_safe()
                        stage_path.unlink()
                    finally:
                        self._assert_publication_process_safe()
                        if os.path.lexists(object_path):
                            object_path.chmod(_readonly_mode(mode))
                else:
                    self._assert_publication_process_safe()
                    stage_path.unlink()
                self._assert_publication_process_safe()
                self._verify_object(
                    object_path,
                    digest=digest,
                    mode=mode,
                    size=size,
                )
                self._assert_publication_process_safe()
                return True
        except SourceContentStoreError:
            raise
        except OSError as error:
            raise SourceContentStoreError(
                f"cannot safely remove capture-stage hard link: {stage_path}"
            ) from error


__all__ = ["SourceContentStore", "SourceContentStoreError"]
