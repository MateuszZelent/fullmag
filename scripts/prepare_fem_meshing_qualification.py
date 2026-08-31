#!/usr/bin/env python3
"""Prepare a fail-closed, source-only FEM meshing qualification input."""

from __future__ import annotations

import argparse
import ctypes
from dataclasses import dataclass
import os
from pathlib import Path
import stat
import subprocess
import sys
from typing import Sequence
import uuid

import capture_source_snapshot_identity as source_identity


SOURCE_SNAPSHOT_NAME = "source-snapshot-before.v1.json"
SCOPE_NAME = "qualification-scope.v1.json"
EVIDENCE_LEASE_NAME = ".fem-meshing-qualification.lease"
KNOWN_EVIDENCE_ROOT_NAMES = frozenset(
    {
        ".fullmag-build",
        ".fullmag-cache",
        ".fullmag-cargo",
        ".fullmag-rustup",
        "fullmag-build",
        "fullmag-cache",
        "fullmag-tmp",
        "target",
        "runtime",
        "runtimes",
        "fem-gpu-host",
        "fem-gpu-variants",
    }
)
ACTIVE_GIT_PATHS = (
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-apply",
    "rebase-merge",
)

# Use the canonical serializer, digest, and atomic-file writer from the only
# source identity implementation; this wrapper deliberately owns no hash logic.
_canonical_bytes = source_identity._canonical_bytes
_sha256 = source_identity._sha256


class PreflightError(RuntimeError):
    pass


@dataclass(frozen=True)
class OwnedPath:
    path: Path
    identity: tuple[int, int]


@dataclass(frozen=True)
class EvidenceRoot:
    supplied: Path
    canonical: Path
    ancestry: tuple[tuple[Path, tuple[int, int]], ...]
    supplied_ancestry: tuple[tuple[Path, tuple[int, int]], ...]
    initial_root_identity: tuple[int, int] | None


@dataclass(frozen=True)
class EvidenceLease:
    evidence: EvidenceRoot
    root_created: bool
    root_identity: tuple[int, int]
    owned: OwnedPath


def _git(repo_root: Path, invariant: str, *arguments: str) -> bytes:
    try:
        return subprocess.check_output(
            ("git", *arguments), cwd=repo_root, stderr=subprocess.PIPE
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise PreflightError(f"cannot inspect Git {invariant}") from error


def _git_path(repo_root: Path, name: str) -> Path:
    try:
        raw = _git(repo_root, f"marker {name}", "rev-parse", "--git-path", name).decode(
            "utf-8"
        ).strip()
    except UnicodeDecodeError as error:
        raise PreflightError(f"cannot decode Git marker {name}") from error
    path = Path(raw)
    return path if path.is_absolute() else repo_root / path


def _canonical_repo_root(repo_root: Path) -> Path:
    try:
        supplied = repo_root.resolve()
    except (OSError, RuntimeError) as error:
        raise PreflightError("cannot resolve repository root") from error
    try:
        raw = _git(supplied, "top-level", "rev-parse", "--show-toplevel")
    except PreflightError as error:
        raise PreflightError("repository root is not the Git top-level") from error
    try:
        top_level = Path(raw.decode("utf-8").strip()).resolve()
    except UnicodeDecodeError as error:
        raise PreflightError("cannot decode Git top-level") from error
    except (OSError, RuntimeError) as error:
        raise PreflightError("cannot resolve Git top-level") from error
    if supplied != top_level:
        raise PreflightError("repository root is not the Git top-level")
    return supplied


def _validate_git_state(repo_root: Path) -> None:
    for name in ACTIVE_GIT_PATHS:
        if os.path.lexists(_git_path(repo_root, name)):
            raise PreflightError("active Git operation")
    if os.path.lexists(_git_path(repo_root, "index.lock")):
        raise PreflightError("Git index lock")
    if _git(repo_root, "unmerged index", "ls-files", "--unmerged", "-z"):
        raise PreflightError("unmerged Git index entries")


def _is_link_or_reparse(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    except OSError as error:
        raise PreflightError("cannot inspect evidence root") from error
    return path.is_symlink() or bool(
        getattr(metadata, "st_file_attributes", 0) & 0x400
    )


def _evidence_ancestry_is_forbidden(repo_root: Path, candidate: Path) -> str | None:
    if candidate == repo_root or repo_root in candidate.parents:
        return "evidence root is inside repository"
    if any(
        part.name.lower() in KNOWN_EVIDENCE_ROOT_NAMES
        for part in (candidate, *candidate.parents)
    ):
        return "evidence root is a known build/cache/runtime root"
    return None


def _path_identity(path: Path, invariant: str) -> tuple[int, int]:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise PreflightError(f"cannot inspect {invariant}") from error
    return metadata.st_dev, metadata.st_ino


def _owned_path(
    path: Path, identity: tuple[int, int] | None = None
) -> OwnedPath:
    return OwnedPath(
        path,
        identity if identity is not None else _path_identity(path, "publication path"),
    )


def _require_empty_evidence_root(evidence_root: Path) -> bool:
    if os.path.lexists(evidence_root):
        if _is_link_or_reparse(evidence_root):
            raise PreflightError("evidence root must not be a link")
        try:
            if not evidence_root.is_dir() or any(evidence_root.iterdir()):
                raise PreflightError("evidence root is not empty")
        except OSError as error:
            raise PreflightError("cannot inspect evidence root") from error
        return False
    if not evidence_root.parent.is_dir():
        raise PreflightError("evidence root parent does not exist")
    return True


def _validate_evidence_root(repo_root: Path, evidence_root: Path) -> EvidenceRoot:
    try:
        supplied = evidence_root.absolute()
    except OSError as error:
        raise PreflightError("cannot resolve evidence root") from error
    if os.path.lexists(supplied) and _is_link_or_reparse(supplied):
        raise PreflightError("evidence root must not be a link")
    try:
        resolved = supplied.resolve()
    except (OSError, RuntimeError) as error:
        raise PreflightError("cannot resolve evidence root") from error
    for candidate in (supplied, resolved):
        failure = _evidence_ancestry_is_forbidden(repo_root, candidate)
        if failure is not None:
            raise PreflightError(failure)
    root_exists = not _require_empty_evidence_root(resolved)
    try:
        ancestry = tuple(
            (parent, _path_identity(parent, "evidence root ancestry"))
            for parent in resolved.parents
        )
        supplied_ancestry = tuple(
            (parent, _path_identity(parent, "evidence root supplied ancestry"))
            for parent in supplied.parents
        )
    except PreflightError:
        raise
    return EvidenceRoot(
        supplied=supplied,
        canonical=resolved,
        ancestry=ancestry,
        supplied_ancestry=supplied_ancestry,
        initial_root_identity=(
            _path_identity(resolved, "evidence root") if root_exists else None
        ),
    )


def _revalidate_evidence_root(evidence: EvidenceRoot, *, require_empty: bool) -> bool:
    try:
        resolved = evidence.supplied.resolve()
    except (OSError, RuntimeError) as error:
        raise PreflightError("cannot resolve evidence root") from error
    if resolved != evidence.canonical:
        raise PreflightError("evidence root target changed")
    if os.path.lexists(resolved) and _is_link_or_reparse(resolved):
        raise PreflightError("evidence root must not be a link")
    for parent, identity in evidence.ancestry:
        if _path_identity(parent, "evidence root ancestry") != identity:
            raise PreflightError("evidence root ancestry changed")
    for parent, identity in evidence.supplied_ancestry:
        if _path_identity(parent, "evidence root supplied ancestry") != identity:
            raise PreflightError("evidence root ancestry changed")
    if evidence.initial_root_identity is not None:
        if _path_identity(resolved, "evidence root") != evidence.initial_root_identity:
            raise PreflightError("evidence root identity changed")
    return _require_empty_evidence_root(resolved) if require_empty else False


def _normalized_input_path(raw: str) -> str:
    if not raw:
        raise PreflightError("unsafe qualification input")
    try:
        candidate = source_identity._safe_relative_path(raw, "qualification input")
    except source_identity.SourceIdentityError as error:
        raise PreflightError("unsafe qualification input") from error
    normalized = candidate.as_posix()
    if normalized in {"", "."}:
        raise PreflightError("unsafe qualification input")
    return normalized


def _validate_qualification_inputs(
    repo_root: Path, inputs: Sequence[str]
) -> tuple[tuple[str, int, int, str], ...]:
    if not inputs:
        raise PreflightError("qualification input is required")
    normalized: list[tuple[str, int, int, str]] = []
    seen_paths: set[str] = set()
    seen_physical: set[tuple[int, int]] = set()
    seen_canonical: set[str] = set()
    for raw in inputs:
        relative = _normalized_input_path(raw)
        path_key = os.path.normcase(relative) if os.name == "nt" else relative
        if path_key in seen_paths:
            raise PreflightError("duplicate qualification input")
        path = repo_root / Path(relative)
        try:
            canonical = source_identity._resolve_contained_path(
                repo_root, path, "qualification input"
            )
            canonical_parent = source_identity._resolve_contained_path(
                repo_root, path.parent, "qualification input"
            )
            source_identity._validate_filesystem_symlink_path(repo_root, relative)
            metadata = (canonical_parent / path.name).lstat()
        except source_identity.SourceIdentityError as error:
            raise PreflightError("qualification input escapes repository") from error
        except FileNotFoundError as error:
            raise PreflightError("qualification input is missing") from error
        except OSError as error:
            raise PreflightError("cannot inspect qualification input") from error
        if not stat.S_ISREG(metadata.st_mode):
            raise PreflightError("qualification input is not a regular file")
        physical = (metadata.st_dev, metadata.st_ino)
        canonical_key = os.path.normcase(str(canonical)) if os.name == "nt" else str(canonical)
        if physical in seen_physical or canonical_key in seen_canonical:
            raise PreflightError("duplicate qualification input")
        seen_paths.add(path_key)
        seen_physical.add(physical)
        seen_canonical.add(canonical_key)
        normalized.append((relative, *physical, canonical_key))
    return tuple(normalized)


def _capture_stable_identity(
    repo_root: Path, qualification_inputs: Sequence[str]
) -> dict[str, object]:
    try:
        return source_identity.capture(repo_root, qualification_inputs=qualification_inputs)
    except (source_identity.SourceIdentityError, OSError, RuntimeError) as error:
        raise PreflightError("source identity capture failed") from error


def _validate_captured_qualification_inputs(
    repo_root: Path,
    inputs: Sequence[str],
    initial: tuple[tuple[str, int, int, str], ...],
    expected: object,
) -> None:
    if _validate_qualification_inputs(repo_root, inputs) != initial:
        raise PreflightError("qualification inputs changed during capture")
    try:
        fresh = source_identity._qualification_input_content(
            repo_root, tuple(item[0] for item in initial)
        )
    except (source_identity.SourceIdentityError, OSError, RuntimeError) as error:
        raise PreflightError("qualification inputs changed during capture") from error
    if fresh != expected:
        raise PreflightError("qualification inputs changed during capture")


def _scope(identity: dict[str, object]) -> dict[str, object]:
    inputs = identity.get("qualification_inputs")
    if not isinstance(inputs, list):
        raise PreflightError("source identity is missing qualification inputs")
    source_digest = identity.get("source_snapshot_sha256")
    if not isinstance(source_digest, str):
        raise PreflightError("source identity is missing snapshot digest")
    payload: dict[str, object] = {
        "schema": "fullmag.fem-meshing-qualification-scope.v1",
        "status": "prepared",
        "scenario": "S13",
        "geometry": "box",
        "airbox": "bbox",
        "strategy": "mixed_p1",
        "lanes": ["fem_cpu", "fem_gpu_forced"],
        "precision": "double",
        "source_snapshot": SOURCE_SNAPSHOT_NAME,
        "source_snapshot_sha256": source_digest,
        "qualification_inputs": inputs,
    }
    return {
        **payload,
        "qualification_scope_sha256": _sha256(_canonical_bytes(payload)),
    }


def _remove_owned_path(owned: OwnedPath) -> None:
    _remove_path_if_owned(owned.path, owned.identity)


def _remove_path_if_owned(path: Path, identity: tuple[int, int]) -> None:
    if not os.path.lexists(path):
        return
    if _path_identity(path, "publication path") != identity:
        raise PreflightError("publication rollback blocked by concurrent mutation")
    if os.name == "nt":
        _remove_owned_windows(path, identity)
        return
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        else:
            raise OSError("unexpected owned publication directory")
    except OSError as error:
        raise PreflightError("publication rollback failed") from error


def _remove_owned_windows(path: Path, identity: tuple[int, int]) -> None:
    """Delete the opened file handle, never a re-resolved pathname.

    Windows has no portable ``unlinkat`` equivalent in :mod:`os`.  Opening
    the exact entry and applying ``FILE_DISPOSITION_INFO`` to that handle
    makes a replacement at the pathname independent from the deletion of the
    originally owned file.  The handle is identity-checked before disposition
    is set; a mismatch is therefore fail-closed and leaves the foreign entry.
    """

    if os.name != "nt":
        raise PreflightError("Windows handle deletion called on non-Windows host")
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    set_file_information = kernel32.SetFileInformationByHandle
    set_file_information.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
    )
    set_file_information.restype = wintypes.BOOL

    GENERIC_READ = 0x80000000
    DELETE = 0x00010000
    FILE_READ_ATTRIBUTES = 0x00000080
    FILE_SHARE_READ = 0x00000001
    FILE_SHARE_WRITE = 0x00000002
    FILE_SHARE_DELETE = 0x00000004
    OPEN_EXISTING = 3
    FILE_ATTRIBUTE_NORMAL = 0x00000080
    FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    FILE_DISPOSITION_INFO = 4
    handle = create_file(
        str(path),
        GENERIC_READ | DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    invalid = ctypes.c_void_p(-1).value
    if handle == invalid:
        error = ctypes.get_last_error()
        if error == 2:
            return
        raise PreflightError("publication rollback failed")
    descriptor = -1
    disposition_set = False
    try:
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None
        metadata = os.fstat(descriptor)
        observed = (metadata.st_dev, metadata.st_ino)
        if observed != identity:
            raise PreflightError("publication rollback blocked by concurrent mutation")
        disposition = ctypes.c_byte(1)
        if not set_file_information(
            msvcrt.get_osfhandle(descriptor),
            FILE_DISPOSITION_INFO,
            ctypes.byref(disposition),
            ctypes.sizeof(disposition),
        ):
            raise OSError(ctypes.get_last_error(), "SetFileInformationByHandle")
        disposition_set = True
    except PreflightError:
        raise
    except OSError as error:
        raise PreflightError("publication rollback failed") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        elif handle not in (None, invalid):
            kernel32.CloseHandle(handle)
    if not disposition_set:
        raise PreflightError("publication rollback failed")


def _discard_open_descriptor(descriptor: int, path: Path) -> None:
    """Discard a just-created file when descriptor identity is unavailable."""

    if os.name == "nt":
        import msvcrt

        # The descriptor is still the handle returned by O_EXCL.  Applying
        # delete disposition to that handle is safe even if the pathname was
        # concurrently replaced; the replacement is a different file object.
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        set_file_information = kernel32.SetFileInformationByHandle
        set_file_information.argtypes = (
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPVOID,
            wintypes.DWORD,
        )
        set_file_information.restype = wintypes.BOOL
        disposition = ctypes.c_byte(1)
        try:
            if not set_file_information(
                msvcrt.get_osfhandle(descriptor),
                4,
                ctypes.byref(disposition),
                ctypes.sizeof(disposition),
            ):
                raise OSError(ctypes.get_last_error(), "SetFileInformationByHandle")
        finally:
            os.close(descriptor)
        return
    try:
        os.close(descriptor)
    finally:
        # On POSIX this is the best available fallback when fstat itself
        # failed.  Normal paths always have descriptor identity and use the
        # identity-checked cleanup above.
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def _open_exclusive(path: Path) -> int:
    """Open a new writable file while retaining Windows delete rights."""

    if os.name != "nt":
        return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    from ctypes import wintypes
    import msvcrt

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create_file.restype = wintypes.HANDLE
    GENERIC_WRITE = 0x40000000
    DELETE = 0x00010000
    FILE_READ_ATTRIBUTES = 0x00000080
    FILE_SHARE_READ = 0x00000001
    FILE_SHARE_WRITE = 0x00000002
    FILE_SHARE_DELETE = 0x00000004
    CREATE_NEW = 1
    FILE_ATTRIBUTE_NORMAL = 0x00000080
    FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    handle = create_file(
        str(path),
        GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        None,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    invalid = ctypes.c_void_p(-1).value
    if handle == invalid:
        error = ctypes.get_last_error()
        if error == 80:
            raise FileExistsError(error, "file already exists", str(path))
        raise OSError(error, "CreateFileW", str(path))
    try:
        return msvcrt.open_osfhandle(handle, os.O_WRONLY | os.O_BINARY)
    except BaseException:
        kernel32.CloseHandle(handle)
        raise


def _rollback_publication(
    evidence_root: Path,
    owned_paths: Sequence[OwnedPath],
    remove_root: bool,
) -> None:
    failures: list[PreflightError] = []
    for owned in reversed(owned_paths):
        try:
            _remove_owned_path(owned)
        except PreflightError as error:
            # A foreign replacement must never be removed, but it must not
            # prevent cleanup of the other paths owned by this run.
            failures.append(error)
    try:
        entries = list(evidence_root.iterdir()) if evidence_root.exists() else []
    except OSError as error:
        raise PreflightError("publication rollback failed") from error
    if entries:
        raise PreflightError("publication rollback blocked by concurrent mutation")
    if failures:
        raise failures[0]
    # Keep a newly created root empty instead of removing it.  There is no
    # portable identity-preserving directory unlink on Windows; leaving an
    # empty root satisfies the absent/empty invariant without a pathname race.
    if remove_root:
        return


def _write_exclusive_json(path: Path, payload: object, owned_paths: list[OwnedPath]) -> None:
    try:
        descriptor = _open_exclusive(path)
    except FileExistsError as error:
        raise PreflightError("publication collision") from error
    except OSError as error:
        raise PreflightError("publication failed") from error
    identity: tuple[int, int] | None = None
    try:
        metadata = os.fstat(descriptor)
        identity = (metadata.st_dev, metadata.st_ino)
        owned_paths.append(
            OwnedPath(path, identity)
        )
    except BaseException:
        if identity is None:
            try:
                _discard_open_descriptor(descriptor, path)
            except (OSError, PreflightError):
                pass
        else:
            try:
                os.close(descriptor)
            finally:
                try:
                    _remove_path_if_owned(path, identity)
                except (OSError, PreflightError):
                    pass
        raise
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(_canonical_bytes(payload))
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        raise


def _acquire_evidence_lease(evidence: EvidenceRoot) -> EvidenceLease:
    _revalidate_evidence_root(evidence, require_empty=False)
    if os.path.lexists(evidence.canonical / EVIDENCE_LEASE_NAME):
        raise PreflightError("evidence root is busy")
    root_created = _require_empty_evidence_root(evidence.canonical)
    if root_created:
        try:
            evidence.canonical.mkdir()
        except FileExistsError as error:
            raise PreflightError("evidence root changed before publication") from error
        except OSError as error:
            raise PreflightError("cannot create evidence root") from error
    root_identity = _path_identity(evidence.canonical, "evidence root")
    lease_path = evidence.canonical / EVIDENCE_LEASE_NAME
    owned_paths: list[OwnedPath] = []
    try:
        descriptor = _open_exclusive(lease_path)
    except FileExistsError as error:
        raise PreflightError("evidence root is busy") from error
    except OSError as error:
        raise PreflightError("cannot acquire evidence root lease") from error
    identity: tuple[int, int] | None = None
    try:
        metadata = os.fstat(descriptor)
        identity = (metadata.st_dev, metadata.st_ino)
        owned_paths.append(
            OwnedPath(lease_path, identity)
        )
    except BaseException:
        if identity is None:
            try:
                _discard_open_descriptor(descriptor, lease_path)
            except (OSError, PreflightError):
                pass
        else:
            try:
                os.close(descriptor)
            finally:
                try:
                    _remove_path_if_owned(lease_path, identity)
                except (OSError, PreflightError):
                    pass
        raise PreflightError("cannot acquire evidence root lease")
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(b"fem-meshing-qualification\n")
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException as error:
        try:
            _rollback_publication(
                evidence.canonical,
                owned_paths,
                root_created,
            )
        except PreflightError as rollback_error:
            raise rollback_error from error
        raise PreflightError("cannot acquire evidence root lease") from error
    return EvidenceLease(evidence, root_created, root_identity, owned_paths[0])


def _validate_lease(lease: EvidenceLease) -> None:
    _revalidate_evidence_root(lease.evidence, require_empty=False)
    if _path_identity(lease.evidence.canonical, "evidence root") != lease.root_identity:
        raise PreflightError("evidence root identity changed")
    if _path_identity(lease.owned.path, "evidence root lease") != lease.owned.identity:
        raise PreflightError("evidence root lease changed")


def _promote_owned_file(
    lease: EvidenceLease,
    staged: OwnedPath,
    destination: Path,
    owned_paths: list[OwnedPath],
) -> OwnedPath:
    _validate_lease(lease)
    if _path_identity(staged.path, "publication path") != staged.identity:
        raise PreflightError("publication path changed")
    # Register the expected destination before the non-overwriting link.  If
    # link creation or any subsequent operation fails, rollback can inspect
    # the identity: absent means no ownership was created, matching identity
    # means this run owns it, and a different identity is a foreign collision.
    final = OwnedPath(destination, staged.identity)
    owned_paths.append(final)
    try:
        os.link(staged.path, destination)
    except FileExistsError as error:
        raise PreflightError("publication collision") from error
    except OSError as error:
        raise PreflightError("publication failed") from error
    # os.link creates the destination atomically and cannot overwrite an
    # existing entry.  The source and destination are now the same inode.
    _remove_owned_path(staged)
    return final


def _verify_owned_json(owned: OwnedPath, payload: object) -> None:
    """Verify final identity and bytes from one stable read-only handle."""

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(owned.path, flags)
    except OSError as error:
        raise PreflightError("publication artifact changed") from error
    try:
        before = os.fstat(descriptor)
        if (before.st_dev, before.st_ino) != owned.identity:
            raise PreflightError("publication artifact changed")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            content = stream.read()
        after = os.fstat(descriptor)
        if (
            (after.st_dev, after.st_ino) != owned.identity
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
            or content != _canonical_bytes(payload)
        ):
            raise PreflightError("publication artifact changed")
        try:
            path_metadata = owned.path.lstat()
        except OSError as error:
            raise PreflightError("publication artifact changed") from error
        if (path_metadata.st_dev, path_metadata.st_ino) != owned.identity:
            raise PreflightError("publication artifact changed")
    finally:
        os.close(descriptor)


def _publish(evidence: EvidenceRoot, identity: dict[str, object], scope: dict[str, object]) -> None:
    owned_paths: list[OwnedPath] = []
    lease: EvidenceLease | None = None
    try:
        lease = _acquire_evidence_lease(evidence)
        owned_paths.append(lease.owned)
        token = uuid.uuid4().hex
        staged: list[tuple[OwnedPath, Path]] = []
        for name, payload in ((SOURCE_SNAPSHOT_NAME, identity), (SCOPE_NAME, scope)):
            _validate_lease(lease)
            temporary = evidence.canonical / f".{name}.{token}.staging"
            _write_exclusive_json(temporary, payload, owned_paths)
            staged.append((owned_paths[-1], evidence.canonical / name))
        finals: list[tuple[OwnedPath, object]] = []
        for (temporary, destination), payload in zip(
            staged, (identity, scope), strict=True
        ):
            _validate_lease(lease)
            finals.append(
                (_promote_owned_file(lease, temporary, destination, owned_paths), payload)
            )
        _validate_lease(lease)
        # The lease is the transaction marker: while it exists, readers must
        # treat the generation as incomplete.  Verify both final files and no
        # foreign entries before removing the marker as the commit point.
        if {path.name for path in evidence.canonical.iterdir()} != {
            EVIDENCE_LEASE_NAME,
            SOURCE_SNAPSHOT_NAME,
            SCOPE_NAME,
        }:
            raise PreflightError("unexpected Phase-0 artifact set")
        for final, payload in finals:
            _verify_owned_json(final, payload)
        _remove_owned_path(lease.owned)
        owned_paths.remove(lease.owned)
    except BaseException as error:
        try:
            _rollback_publication(
                evidence.canonical,
                owned_paths,
                lease.root_created if lease is not None else False,
            )
        except PreflightError as rollback_error:
            raise rollback_error from error
        if isinstance(error, PreflightError):
            raise
        raise PreflightError("publication failed") from error


def prepare(
    repo_root: Path, evidence_root: Path, qualification_inputs: Sequence[str]
) -> None:
    canonical_repo = _canonical_repo_root(repo_root)
    _validate_git_state(canonical_repo)
    canonical_evidence = _validate_evidence_root(canonical_repo, evidence_root)
    inputs = _validate_qualification_inputs(canonical_repo, qualification_inputs)
    input_paths = tuple(item[0] for item in inputs)
    identity = _capture_stable_identity(canonical_repo, input_paths)
    _validate_captured_qualification_inputs(
        canonical_repo, qualification_inputs, inputs, identity.get("qualification_inputs")
    )
    _validate_git_state(canonical_repo)
    scope = _scope(identity)
    _validate_git_state(canonical_repo)
    _revalidate_evidence_root(canonical_evidence, require_empty=True)
    _publish(canonical_evidence, identity, scope)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--qualification-input", action="append", required=True)
    arguments = parser.parse_args(argv)
    try:
        prepare(
            arguments.repo_root,
            arguments.evidence_root,
            arguments.qualification_input,
        )
    except PreflightError as error:
        print(f"FEM_MESHING_PREFLIGHT_ERROR={error}", file=sys.stderr)
        return 2
    except Exception:
        print("FEM_MESHING_PREFLIGHT_ERROR=preflight failed", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
