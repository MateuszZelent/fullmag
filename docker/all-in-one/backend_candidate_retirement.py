"""Crash-safe retirement of unpublished direct backend package candidates.

This module is deliberately independent of ``backend_dev`` imports.  The
caller passes the loaded backend module as ``b``; that keeps the helper safe
when the backend is executed as ``__main__`` and lets the integration reuse
the backend's existing path, hashing, package, and durability validators.

The helper only handles a complete ``ready`` candidate which never entered a
package rotation journal.  It returns a promotion decision to the caller but
never performs promotion itself, and it never touches the current package,
rollback chain, cache, user data, or runtime provenance.  The caller remains
responsible for the existing rotation path when the candidate matches the
fresh source and is not a duplicate of the current package.
"""

from __future__ import annotations

from collections.abc import Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from itertools import islice
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import time
from typing import Any


RETIREMENT_SCHEMA = "fullmag.direct-compose.package-candidate-retirement.v1"
RETIREMENT_NAMESPACE_NAME = "candidate-retirements"
RETIREMENT_RECORD_NAME = "retirement.json"
RETIREMENT_ARCHIVE_PREFIX = ".backend-package-candidate-retirement-"
RETIREMENT_ARCHIVE_NAME_RE = re.compile(
    r"^\.backend-package-candidate-retirement-[A-Za-z0-9._-]+$"
)
RETIREMENT_STAGING_NAMESPACE_NAME = "candidate-retirement-staging"
RETIREMENT_STAGING_NAME_RE = re.compile(
    r"^\.backend-package-candidate-staging-[A-Za-z0-9._-]+$"
)
RETIREMENT_MAX_ARCHIVES = 64
RETIREMENT_MAX_BYTES = 64 * 1024 * 1024
RETIREMENT_MAX_STAGING_ENTRIES = 4
RETIREMENT_MAX_STAGING_BYTES = 64 * 1024 * 1024
RETIREMENT_ARTIFACT_INVENTORY_SCHEMA = (
    "fullmag.direct-compose.package-candidate-artifact-inventory.v1"
)
RETIREMENT_STATES = frozenset({"prepared", "deletion-pending", "succeeded", "historical"})
RETIREMENT_CLASSIFICATIONS = frozenset({"stale", "duplicate", "promoted"})
RETIREMENT_ROLES = frozenset({"marker", "receipt", "log", "metadata", "payload"})


class _LiveManifestMissing(FileNotFoundError):
    """The fixed manifest is absent; a sealed prepared archive may replace it."""


@dataclass(frozen=True)
class ReadyCandidateSpec:
    """Read-only evidence for one complete, unpublished candidate."""

    candidate: Path
    output: Path
    control_root: Path
    build_root: Path
    marker: dict[str, Any]
    marker_bytes: bytes
    receipt: dict[str, Any]
    receipt_bytes: bytes
    artifacts: tuple[dict[str, Any], ...]
    artifact_inventory_sha256: str
    candidate_receipt_sha256: str
    marker_sha256: str
    candidate_files: tuple[dict[str, Any], ...]
    attempt: dict[str, Any]
    attempt_dir: Path
    attempt_receipt: Path
    attempt_log: Path
    attempt_receipt_bytes: bytes
    source_manifest: dict[str, Any]
    source_manifest_bytes: bytes
    source_manifest_sha256: str


@dataclass(frozen=True)
class RetirementResult:
    """Outcome consumed by the existing start/rotation integration."""

    action: str
    classification: str | None
    candidate: Path
    archive: Path | None
    external_log_retired: bool


def _fail(b: Any, message: str) -> None:
    b._fail(message)


def _absolute(b: Any, path: Path, name: str) -> Path:
    return b._absolute(Path(path), name)


def _sha256_file(b: Any, path: Path, name: str, maximum: int | None = None) -> tuple[str, int]:
    digest, metadata = b._sha256_file(path, name, maximum)
    return digest, int(metadata.st_size)


def _require_sha256(b: Any, value: object, name: str) -> str:
    if not isinstance(value, str) or not b.SHA256_RE.fullmatch(value):
        _fail(b, f"{name} is not a SHA-256 digest")
    return value


def _require_int(b: Any, value: object, name: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        _fail(b, f"{name} is invalid")
    return value


def _safe_relative(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} is invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"{name} is unsafe")
    return path.as_posix()


def _safe_relative_or_fail(b: Any, value: object, name: str) -> str:
    try:
        return _safe_relative(value, name)
    except ValueError as error:
        _fail(b, str(error))
    raise AssertionError("_fail must raise")


def _candidate_paths(
    b: Any,
    candidate: Path,
    output: Path,
    control_root: Path,
    build_root: Path,
) -> tuple[Path, Path, Path, Path]:
    candidate = _absolute(b, candidate, "backend package candidate")
    output = _absolute(b, output, "backend output")
    control_root = _absolute(
        b, control_root, "backend package development control directory"
    )
    build_root = _absolute(b, build_root, "backend build root")
    expected_control = output / b.PACKAGE_DEVELOPMENT_DIRNAME
    expected_parent = expected_control / b.PACKAGE_CANDIDATES_DIRNAME
    if control_root != expected_control:
        _fail(b, "candidate retirement control directory is not under the package root")
    if (
        candidate == output
        or candidate.parent != expected_parent
        or not b.PACKAGE_CANDIDATE_NAME_RE.fullmatch(candidate.name)
    ):
        _fail(b, "candidate retirement candidate is outside the owned namespace")
    b._assert_no_links(candidate, "candidate retirement candidate")
    return candidate, output, control_root, build_root


def _candidate_file_role(b: Any, relative: str) -> str:
    if relative == b.PACKAGE_CANDIDATE_MARKER:
        return "marker"
    if relative == "backend-build-receipt.json":
        return "receipt"
    if relative in {
        b.FAILED_MAKE_LOG_NAME,
        "install-cli-build.log",
        "install-cli-managed-fem-gpu.log",
    }:
        return "log"
    if relative in {
        "source-identity.json",
        "launcher-build-mode",
        *b.RUNTIME_MANIFEST_PATHS,
    }:
        return "metadata"
    return "payload"


@contextmanager
def _shared_candidate_artifact_proof(
    b: Any,
    candidate: Path,
    receipt: Mapping[str, Any],
    linked_paths: set[str],
):
    """Hold the exact shared key claim while proving candidate hardlinks."""

    if not linked_paths:
        yield {}
        return
    still_linked: set[str] = set()
    for relative in linked_paths:
        metadata = candidate.joinpath(*PurePosixPath(relative).parts).lstat()
        if metadata.st_nlink > 1:
            still_linked.add(relative)
    if not still_linked:
        # A shared-cache eviction or another consumer unlink can turn the
        # candidate's remaining receipt-checked file into a private one before
        # the key claim is acquired.  Private inventory/hash checks still bind
        # it; do not require a now-absent cache entry.
        yield {}
        return
    linked_paths = still_linked
    try:
        import backend_shared_store as shared
    except ImportError as error:
        _fail(b, f"shared candidate artifacts cannot be verified: {error}")

    binding = receipt.get("shared_package")
    source = receipt.get("source")
    native = receipt.get("native_source_identity")
    build = receipt.get("build")
    if not isinstance(binding, Mapping) or not isinstance(source, Mapping):
        _fail(b, "multiply linked candidate artifacts have no shared receipt binding")
    reuse = binding.get("reuse")
    required_binding_keys = {"schema", "key", "inputs", "reuse"}
    if reuse == "verified-hardlinks":
        required_binding_keys.add("producer_receipt_sha256")
    if (
        set(binding) != required_binding_keys
        or binding.get("schema") != shared.SCHEMA
        or reuse not in {"publisher", "verified-hardlinks"}
    ):
        _fail(b, "multiply linked candidate artifact binding is invalid")
    key = binding.get("key")
    inputs = binding.get("inputs")
    if (
        not isinstance(key, str)
        or not shared.HEX.fullmatch(key)
        or not isinstance(inputs, Mapping)
        or shared.key_for(inputs) != key
    ):
        _fail(b, "multiply linked candidate artifact key or inputs differ")
    if reuse == "verified-hardlinks":
        _require_sha256(
            b,
            binding.get("producer_receipt_sha256"),
            "shared candidate producer receipt digest",
        )

    if (
        not isinstance(native, Mapping)
        or inputs.get("native_source_identity") != native
        or inputs.get("toolchain") != receipt.get("toolchain")
        or inputs.get("resolved_commit") != source.get("resolved_commit")
        or inputs.get("runtime_source_digest") != source.get("runtime_source_digest")
        or not isinstance(inputs.get("build"), Mapping)
        or not isinstance(build, Mapping)
        or any(build.get(name) != value for name, value in inputs["build"].items())
    ):
        _fail(b, "multiply linked candidate artifact identity differs from its receipt")

    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list) or any(not isinstance(item, Mapping) for item in artifacts):
        _fail(b, "multiply linked candidate has no valid artifact inventory")
    artifact_by_path: dict[str, dict[str, Any]] = {}
    for item in artifacts:
        relative = _safe_relative_or_fail(b, item.get("path"), "shared candidate artifact path")
        if relative in artifact_by_path:
            _fail(b, f"shared candidate artifact inventory duplicates {relative}")
        if (
            set(item) != {"path", "size", "sha256", "mode"}
            or isinstance(item.get("size"), bool)
            or not isinstance(item.get("size"), int)
            or item["size"] < 0
            or item.get("mode") not in {"100644", "100755"}
        ):
            _fail(b, f"shared candidate artifact record is invalid: {relative}")
        _require_sha256(b, item.get("sha256"), f"shared candidate artifact digest {relative}")
        artifact_by_path[relative] = dict(item)
    if not linked_paths.issubset(artifact_by_path):
        _fail(b, "multiply linked candidate includes a non-artifact file")

    configured = b.os.environ.get("FULLMAG_SHARED_BACKEND_STORE", "")
    if configured != str(shared.ROOT):
        _fail(b, "multiply linked candidate artifacts require the managed shared store")
    try:
        store = shared.Store(Path(configured))
        with store.claim(dict(inputs)) as entry:
            cached = entry.read()
            if cached is None:
                _fail(b, "shared candidate artifact entry is missing")
            cached_receipt = cached.get("receipt")
            if not isinstance(cached_receipt, Mapping):
                _fail(b, "shared candidate artifact entry has no receipt")
            cached_artifacts = cached_receipt.get("artifacts")
            if cached_artifacts != artifacts:
                _fail(b, "shared candidate artifact inventory differs from its entry")
            if reuse == "publisher":
                if dict(cached_receipt) != dict(receipt):
                    _fail(b, "shared publisher candidate receipt differs from its entry")
            else:
                cached_binding = cached_receipt.get("shared_package")
                if (
                    not isinstance(cached_binding, Mapping)
                    or cached_binding.get("schema") != shared.SCHEMA
                    or cached_binding.get("reuse") != "publisher"
                    or cached_binding.get("key") != key
                    or cached_binding.get("inputs") != dict(inputs)
                    or b._sha256_bytes(shared.canonical(dict(cached_receipt)))
                    != binding.get("producer_receipt_sha256")
                ):
                    _fail(b, "shared consumer candidate producer receipt differs")

            linked_identities: dict[str, tuple[int, int]] = {}
            for relative in sorted(linked_paths):
                record = artifact_by_path[relative]
                candidate_path = candidate.joinpath(*PurePosixPath(relative).parts)
                shared_path = entry.path.joinpath(*PurePosixPath(relative).parts)
                candidate_metadata = shared.safe_path(candidate_path)
                shared_metadata = shared.safe_path(shared_path)
                if (
                    not stat.S_ISREG(candidate_metadata.st_mode)
                    or not stat.S_ISREG(shared_metadata.st_mode)
                    or candidate_metadata.st_nlink < 2
                    or candidate_metadata.st_mode & 0o222
                    or (candidate_metadata.st_dev, candidate_metadata.st_ino)
                    != (shared_metadata.st_dev, shared_metadata.st_ino)
                ):
                    _fail(b, f"shared candidate artifact is not its sealed entry link: {relative}")
                shared._verify(candidate_path, record, sealed=True)
                after = shared.safe_path(candidate_path)
                if (
                    (after.st_dev, after.st_ino)
                    != (candidate_metadata.st_dev, candidate_metadata.st_ino)
                    or after.st_size != candidate_metadata.st_size
                    or after.st_mode != candidate_metadata.st_mode
                ):
                    _fail(b, f"shared candidate artifact changed during verification: {relative}")
                linked_identities[relative] = (after.st_dev, after.st_ino)
            yield linked_identities
    except shared.StoreError as error:
        _fail(b, f"shared candidate artifact proof failed: {error}")
    except (OSError, ValueError, TypeError, KeyError) as error:
        _fail(b, f"shared candidate artifact proof is malformed: {error}")


def _candidate_file_records(
    b: Any, candidate: Path, receipt: Mapping[str, Any]
) -> tuple[dict[str, Any], ...]:
    try:
        files, directories = b._stage_tree_inventory(candidate)
    except (b.BackendBuildError, OSError):
        raise
    if len(files) > b.MAX_FAILED_CANDIDATE_ENTRIES:
        _fail(b, "candidate retirement file inventory is unbounded")
    allowed_directories: set[str] = set()
    for relative in files:
        parts = PurePosixPath(relative).parts
        allowed_directories.update(
            PurePosixPath(*parts[:index]).as_posix()
            for index in range(1, len(parts))
        )
    if not directories.issubset(allowed_directories):
        _fail(b, "candidate retirement contains an unowned directory")
    artifact_paths: set[str] = set()
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list) or any(not isinstance(item, Mapping) for item in artifacts):
        _fail(b, "candidate retirement file inventory has no artifact receipt")
    for item in artifacts:
        relative = _safe_relative_or_fail(b, item.get("path"), "candidate artifact path")
        if relative in artifact_paths:
            _fail(b, f"candidate retirement artifact inventory duplicates {relative}")
        artifact_paths.add(relative)
    linked_paths: set[str] = set()
    for relative in files:
        metadata = candidate.joinpath(*PurePosixPath(relative).parts).lstat()
        if metadata.st_nlink > 1:
            if relative not in artifact_paths:
                _fail(b, f"candidate retirement non-artifact file is multiply linked: {relative}")
            linked_paths.add(relative)

    records: list[dict[str, Any]] = []
    with _shared_candidate_artifact_proof(b, candidate, receipt, linked_paths) as shared_links:
        for relative in sorted(files):
            path = candidate.joinpath(*PurePosixPath(relative).parts)
            metadata = path.lstat()
            if (
                stat.S_ISLNK(metadata.st_mode)
                or bool(getattr(metadata, "st_file_attributes", 0) & 0x400)
                or not stat.S_ISREG(metadata.st_mode)
                or (metadata.st_nlink != 1 and relative not in shared_links)
            ):
                _fail(b, f"candidate retirement file is unsafe: {relative}")
            if relative in shared_links:
                digest, hashed_metadata = b._sha256_file(
                    path,
                    f"candidate retirement file {relative}",
                    b.MAX_SOURCE_BYTES,
                    package_artifact=True,
                )
                size = int(hashed_metadata.st_size)
                if (
                    (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mode)
                    != (
                        hashed_metadata.st_dev,
                        hashed_metadata.st_ino,
                        hashed_metadata.st_size,
                        hashed_metadata.st_mode,
                    )
                ):
                    _fail(b, f"shared candidate artifact changed identity while hashing: {relative}")
            else:
                digest, size = _sha256_file(
                    b, path, f"candidate retirement file {relative}", b.MAX_SOURCE_BYTES
                )
            after = path.lstat()
            if (
                (metadata.st_dev, metadata.st_ino) != (after.st_dev, after.st_ino)
                or metadata.st_size != after.st_size
                or metadata.st_mode != after.st_mode
            ):
                _fail(b, f"candidate retirement file changed while hashing: {relative}")
            records.append(
                {
                    "path": relative,
                    "size": size,
                    "sha256": digest,
                    "mode": "100755" if metadata.st_mode & 0o111 else "100644",
                    "role": _candidate_file_role(b, relative),
                }
            )
    return tuple(records)


def _record_map(b: Any, records: tuple[dict[str, Any], ...] | list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for record in records:
        relative = _safe_relative_or_fail(b, record.get("path"), "candidate file path")
        if relative in result:
            _fail(b, f"candidate retirement inventory duplicates {relative}")
        result[relative] = record
    return result


def _attempt_receipt_bytes(b: Any, attempt_receipt: Path) -> bytes:
    raw, metadata = b._read_regular(
        attempt_receipt,
        "candidate retirement Make attempt receipt",
        b.FAILED_MAKE_RECEIPT_BYTES_LIMIT,
    )
    if metadata.st_nlink != 1:
        _fail(b, "candidate retirement Make attempt receipt is multiply linked")
    return raw


def _live_manifest_path(b: Any, build_root: Path) -> Path:
    """Return the fixed live-shadow manifest path without importing backend_source."""

    directory = getattr(b, "LIVE_MANIFEST_DIRNAME", ".fullmag-live-source")
    filename = getattr(b, "LIVE_MANIFEST_FILENAME", "manifest.json")
    if (
        not isinstance(directory, str)
        or not re.fullmatch(r"[A-Za-z0-9._-]+", directory)
        or not isinstance(filename, str)
        or not re.fullmatch(r"[A-Za-z0-9._-]+", filename)
    ):
        _fail(b, "live source manifest path constants are invalid")
    return _absolute(b, build_root / directory / filename, "live source manifest")


def _candidate_source_manifest_sha256(b: Any, receipt: Mapping[str, Any]) -> str:
    source = receipt.get("source")
    if not isinstance(source, Mapping):
        _fail(b, "ready candidate receipt has no source record")
    return _require_sha256(
        b,
        source.get("manifest_sha256"),
        "ready candidate source manifest digest",
    )


def _read_live_manifest_path(
    b: Any,
    path: Path,
    expected_sha256: str,
    name: str,
) -> tuple[dict[str, Any], bytes, bool]:
    b._assert_no_links(path.parent, f"{name} parent")
    try:
        path.lstat()
    except FileNotFoundError as error:
        raise _LiveManifestMissing(path) from error
    except OSError as error:
        _fail(b, f"cannot inspect {name}: {error}")
    document, raw = b._read_json(path, name, 64 * 1024 * 1024)
    b._validate_live_manifest(document)
    return document, raw, b._sha256_bytes(raw) == expected_sha256


def qualify_ready_candidate(
    b: Any,
    candidate: Path,
    output: Path,
    control_root: Path,
    build_root: Path,
) -> ReadyCandidateSpec:
    """Read and validate a full ready candidate without mutating anything."""

    candidate, output, control_root, build_root = _candidate_paths(
        b, candidate, output, control_root, build_root
    )
    marker_path = candidate / b.PACKAGE_CANDIDATE_MARKER
    marker_bytes, marker_metadata = b._read_regular(
        marker_path, "candidate retirement owner marker", 16 * 1024
    )
    if marker_metadata.st_nlink != 1:
        _fail(b, "candidate retirement owner marker is multiply linked")
    marker = b._validate_candidate_marker(
        candidate, output, build_root, state="ready"
    )
    attempt_record = b._read_failed_make_attempt(build_root, candidate)
    if attempt_record is None or attempt_record[0].get("state") != "succeeded":
        _fail(b, "ready candidate has no succeeded Make attempt")
    attempt, attempt_dir, attempt_log = attempt_record
    if attempt.get("exit_code") != 0:
        _fail(b, "ready candidate Make attempt did not exit successfully")
    attempt_receipt = attempt_dir / b.FAILED_MAKE_RECEIPT_NAME
    attempt_receipt_bytes = _attempt_receipt_bytes(b, attempt_receipt)

    receipt, receipt_bytes, _children = b._validated_package(
        candidate,
        "candidate retirement package",
        exclude_candidate_marker=True,
    )
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list) or any(not isinstance(item, Mapping) for item in artifacts):
        _fail(b, "ready candidate has no valid artifact inventory")
    artifact_list = tuple(dict(item) for item in artifacts)
    inventory_sha256 = b._sha256_bytes(b._canonical(list(artifact_list)))
    if marker.get("artifact_inventory_sha256") != inventory_sha256:
        _fail(b, "ready candidate marker inventory proof differs")
    b._assert_direct_candidate_inventory(
        candidate,
        list(artifact_list),
        include_receipt=True,
    )
    candidate_files = _candidate_file_records(b, candidate, receipt)
    by_path = _record_map(b, candidate_files)
    marker_record = by_path.get(b.PACKAGE_CANDIDATE_MARKER)
    if marker_record is None or marker_record["sha256"] != b._sha256_bytes(marker_bytes):
        _fail(b, "ready candidate marker inventory differs from its bytes")
    receipt_record = by_path.get("backend-build-receipt.json")
    if receipt_record is None or receipt_record["sha256"] != b._sha256_bytes(receipt_bytes):
        _fail(b, "ready candidate receipt inventory differs from its bytes")
    candidate_log = by_path.get(b.FAILED_MAKE_LOG_NAME)
    if candidate_log is None or candidate_log["role"] != "log":
        _fail(b, "ready candidate has no published Make diagnostic log")
    if (
        candidate_log["sha256"] != attempt.get("log_sha256")
        or candidate_log["size"] != attempt.get("log_size")
    ):
        _fail(b, "ready candidate Make log differs from its attempt receipt")
    if attempt_log.exists() or attempt_log.is_symlink():
        log_metadata = attempt_log.lstat()
        if (
            stat.S_ISLNK(log_metadata.st_mode)
            or not stat.S_ISREG(log_metadata.st_mode)
            or log_metadata.st_nlink != 1
        ):
            _fail(b, "ready candidate Make diagnostic log is unsafe")
        attempt_log_sha, attempt_log_size = _sha256_file(
            b, attempt_log, "ready candidate external Make log", b.MAX_BUILD_LOG_BYTES
        )
        if attempt_log_sha != attempt.get("log_sha256") or attempt_log_size != attempt.get("log_size"):
            _fail(b, "ready candidate external Make log differs from its receipt")
    elif not attempt.get("log_retired"):
        _fail(b, "ready candidate Make log is absent without retirement proof")

    source_manifest_sha256 = _candidate_source_manifest_sha256(b, receipt)
    try:
        source_manifest, source_manifest_bytes, manifest_matches = _read_live_manifest_path(
            b,
            _live_manifest_path(b, build_root),
            source_manifest_sha256,
            "candidate source live manifest",
        )
    except _LiveManifestMissing:
        source_manifest = None
        source_manifest_bytes = None
        manifest_matches = False

    if not manifest_matches:
        # The fixed path is overwritten by every fresh start.  A previously
        # sealed prepared archive is the only acceptable fallback after that
        # overwrite.  A present but malformed manifest never reaches this
        # branch: validation errors above remain terminal.
        source_manifest, source_manifest_bytes = _read_prepared_source_manifest(
            b,
            candidate,
            output,
            control_root,
            build_root,
            b._sha256_bytes(receipt_bytes),
            source_manifest_sha256,
        )

    spec = ReadyCandidateSpec(
        candidate=candidate,
        output=output,
        control_root=control_root,
        build_root=build_root,
        marker=dict(marker),
        marker_bytes=marker_bytes,
        receipt=dict(receipt),
        receipt_bytes=receipt_bytes,
        artifacts=artifact_list,
        artifact_inventory_sha256=inventory_sha256,
        candidate_receipt_sha256=b._sha256_bytes(receipt_bytes),
        marker_sha256=b._sha256_bytes(marker_bytes),
        candidate_files=candidate_files,
        attempt=dict(attempt),
        attempt_dir=attempt_dir,
        attempt_receipt=attempt_receipt,
        attempt_log=attempt_log,
        attempt_receipt_bytes=attempt_receipt_bytes,
        source_manifest=source_manifest,
        source_manifest_bytes=source_manifest_bytes,
        source_manifest_sha256=source_manifest_sha256,
    )
    archive = _ensure_prepared_archive(b, spec)
    _validate_candidate_source_binding(b, spec, archive)
    return spec


def _retirement_root(b: Any) -> Path:
    return Path(b.BACKEND_CONTROL_ROOT) / RETIREMENT_NAMESPACE_NAME


def _retirement_staging_root(b: Any) -> Path:
    return Path(b.BACKEND_CONTROL_ROOT) / RETIREMENT_STAGING_NAMESPACE_NAME


def _tree_size(b: Any, root: Path) -> int:
    b._assert_safe_tree(root, "candidate retirement archive")
    total = 0
    pending = [root]
    entries_seen = 0
    while pending:
        directory = pending.pop()
        for child in directory.iterdir():
            entries_seen += 1
            if entries_seen > b.MAX_FAILED_CANDIDATE_ENTRIES:
                _fail(b, "candidate retirement archive inventory is unbounded")
            metadata = child.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                pending.append(child)
            elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
                total += metadata.st_size
            else:
                _fail(b, f"candidate retirement archive contains an unsafe entry: {child}")
    return total


def _scan_staging(
    b: Any,
    staging_root: Path,
) -> tuple[list[Path], int]:
    """Validate, count, and retain crash-left staging without auto-cleanup."""

    try:
        entries = tuple(sorted(islice(staging_root.iterdir(), RETIREMENT_MAX_STAGING_ENTRIES + 1), key=lambda path: path.name))
    except FileNotFoundError:
        return [], 0
    except OSError as error:
        _fail(b, f"cannot inspect candidate retirement staging namespace: {error}")
    if len(entries) > RETIREMENT_MAX_STAGING_ENTRIES:
        _fail(b, "candidate retirement staging entry limit is exhausted")
    total_bytes = 0
    result: list[Path] = []
    for entry in entries:
        if not RETIREMENT_STAGING_NAME_RE.fullmatch(entry.name):
            _fail(b, f"candidate retirement staging has an unknown entry: {entry.name}")
        metadata = entry.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            _fail(b, f"candidate retirement staging entry is unsafe: {entry.name}")
        total_bytes += _tree_size(b, entry)
        if total_bytes > RETIREMENT_MAX_STAGING_BYTES:
            _fail(b, "candidate retirement staging byte budget is exhausted")
        result.append(entry)
    return result, total_bytes


def _read_archive_manifest(b: Any, archive: Path) -> tuple[dict[str, Any], bytes]:
    if not RETIREMENT_ARCHIVE_NAME_RE.fullmatch(archive.name):
        _fail(b, f"candidate retirement archive has an unsafe name: {archive.name}")
    metadata = archive.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        _fail(b, "candidate retirement archive is not a regular directory")
    return b._read_json(
        archive / RETIREMENT_RECORD_NAME,
        "candidate retirement record",
        4 * 1024 * 1024,
    )


def _validate_manifest_shape(
    b: Any,
    archive: Path,
    manifest: Mapping[str, Any],
    *,
    require_pending: bool | None = None,
) -> dict[str, Any]:
    state = manifest.get("state")
    if manifest.get("schema") != RETIREMENT_SCHEMA or state not in RETIREMENT_STATES:
        _fail(b, f"candidate retirement archive has an invalid schema/state: {archive.name}")
    if require_pending is True and state != "deletion-pending":
        _fail(b, "candidate retirement archive is not pending deletion")
    if require_pending is False and state != "succeeded":
        _fail(b, "candidate retirement archive is not complete")
    required = {
        "schema",
        "state",
        "archive",
        "candidate",
        "output",
        "control_root",
        "build_root",
        "candidate_name",
        "classification",
        "created_at_ns",
        "candidate_marker_sha256",
        "candidate_receipt_sha256",
        "candidate_artifact_inventory_sha256",
        "source_manifest_sha256",
        "candidate_artifacts",
        "candidate_files",
        "deletion_intent",
        "current_receipt_sha256",
        "current_provenance_sha256",
        "action_at_ns",
        "completed_at_ns",
        "payload_deleted",
        "marker_deleted",
        "attempt",
        "metadata",
    }
    if set(manifest) != required:
        _fail(b, f"candidate retirement archive has unexpected fields: {archive.name}")
    if manifest.get("archive") != str(archive):
        _fail(b, "candidate retirement archive is not bound to its record")
    candidate = _absolute(b, Path(str(manifest.get("candidate"))), "retirement candidate")
    output = _absolute(b, Path(str(manifest.get("output"))), "retirement output")
    control_root = _absolute(
        b, Path(str(manifest.get("control_root"))), "retirement control root"
    )
    build_root = _absolute(b, Path(str(manifest.get("build_root"))), "retirement build root")
    expected_candidate_parent = output / b.PACKAGE_DEVELOPMENT_DIRNAME / b.PACKAGE_CANDIDATES_DIRNAME
    if (
        candidate.parent != expected_candidate_parent
        or not b.PACKAGE_CANDIDATE_NAME_RE.fullmatch(candidate.name)
        or manifest.get("candidate_name") != candidate.name
        or control_root != output / b.PACKAGE_DEVELOPMENT_DIRNAME
    ):
        _fail(b, "candidate retirement archive path binding is invalid")
    classification = manifest.get("classification")
    if state == "prepared":
        if classification is not None:
            _fail(b, "prepared candidate retirement has a deletion classification")
    elif state == "historical":
        if classification != "promoted":
            _fail(b, "historical candidate retirement has no promotion classification")
    elif classification not in RETIREMENT_CLASSIFICATIONS:
        _fail(b, "candidate retirement classification is invalid")
    _require_int(b, manifest.get("created_at_ns"), "candidate retirement creation time", minimum=1)
    if state == "prepared":
        if (
            manifest.get("action_at_ns") is not None
            or manifest.get("completed_at_ns") is not None
            or manifest.get("payload_deleted") is not False
            or manifest.get("marker_deleted") is not False
            or manifest.get("current_receipt_sha256") is not None
            or manifest.get("current_provenance_sha256") is not None
        ):
            _fail(b, "prepared candidate retirement contains deletion authorization")
    else:
        _require_int(b, manifest.get("action_at_ns"), "candidate retirement action time", minimum=1)
        if state == "deletion-pending":
            if (
                manifest.get("completed_at_ns") is not None
                or manifest.get("payload_deleted") is not False
                or manifest.get("marker_deleted") is not False
            ):
                _fail(b, "pending candidate retirement has completion proof")
        elif state == "succeeded":
            _require_int(b, manifest.get("completed_at_ns"), "candidate retirement completion time", minimum=1)
            if manifest.get("payload_deleted") is not True or manifest.get("marker_deleted") is not True:
                _fail(b, "completed candidate retirement has no deletion proof")
        else:
            _require_int(b, manifest.get("completed_at_ns"), "candidate promotion completion time", minimum=1)
            if manifest.get("payload_deleted") is not False or manifest.get("marker_deleted") is not True:
                _fail(b, "historical candidate promotion has invalid completion proof")
    for key in (
        "candidate_marker_sha256",
        "candidate_receipt_sha256",
        "candidate_artifact_inventory_sha256",
        "source_manifest_sha256",
    ):
        _require_sha256(b, manifest.get(key), f"candidate retirement {key}")
    if state != "prepared":
        for key in ("current_receipt_sha256", "current_provenance_sha256"):
            _require_sha256(b, manifest.get(key), f"candidate retirement {key}")
    artifacts = manifest.get("candidate_artifacts")
    if not isinstance(artifacts, list) or any(not isinstance(item, Mapping) for item in artifacts):
        _fail(b, "candidate retirement artifact inventory is invalid")
    candidate_files = manifest.get("candidate_files")
    if not isinstance(candidate_files, list) or not candidate_files:
        _fail(b, "candidate retirement candidate inventory is empty")
    file_paths: set[str] = set()
    for record in candidate_files:
        if not isinstance(record, Mapping) or set(record) != {"path", "size", "sha256", "mode", "role"}:
            _fail(b, "candidate retirement candidate file record is invalid")
        relative = _safe_relative_or_fail(b, record.get("path"), "candidate retirement candidate file")
        if relative in file_paths:
            _fail(b, "candidate retirement candidate inventory has duplicates")
        file_paths.add(relative)
        _require_int(b, record.get("size"), f"candidate retirement size {relative}")
        _require_sha256(b, record.get("sha256"), f"candidate retirement digest {relative}")
        if record.get("mode") not in {"100644", "100755"} or record.get("role") not in RETIREMENT_ROLES:
            _fail(b, f"candidate retirement file record is invalid: {relative}")
    if b.PACKAGE_CANDIDATE_MARKER not in file_paths or "backend-build-receipt.json" not in file_paths:
        _fail(b, "candidate retirement inventory omits marker or receipt")
    deletion_intent = manifest.get("deletion_intent")
    if (
        not isinstance(deletion_intent, list)
        or any(not isinstance(item, str) for item in deletion_intent)
    ):
        _fail(b, "candidate retirement deletion intent is invalid")
    if state in {"prepared", "historical"}:
        if deletion_intent:
            _fail(b, "non-deleting candidate retirement has deletion intent")
    elif len(deletion_intent) != len(file_paths) or set(deletion_intent) != file_paths:
        _fail(b, "candidate retirement deletion intent differs from inventory")
    attempt = manifest.get("attempt")
    if not isinstance(attempt, Mapping):
        _fail(b, "candidate retirement Make attempt summary is invalid")
    if set(attempt) != {
        "receipt_sha256",
        "state",
        "exit_code",
        "log_sha256",
        "log_size",
        "log_retired",
    }:
        _fail(b, "candidate retirement Make attempt summary has unexpected fields")
    _require_sha256(b, attempt.get("receipt_sha256"), "candidate retirement attempt receipt")
    _require_sha256(b, attempt.get("log_sha256"), "candidate retirement attempt log")
    if attempt.get("state") != "succeeded" or attempt.get("exit_code") != 0:
        _fail(b, "candidate retirement Make attempt is not succeeded")
    _require_int(b, attempt.get("log_size"), "candidate retirement attempt log size")
    if not isinstance(attempt.get("log_retired"), bool):
        _fail(b, "candidate retirement attempt log retirement state is invalid")
    metadata = manifest.get("metadata")
    if not isinstance(metadata, list) or not metadata:
        _fail(b, "candidate retirement archive metadata is empty")
    archive_paths: set[str] = set()
    for record in metadata:
        if not isinstance(record, Mapping) or set(record) != {"source", "path", "size", "sha256"}:
            _fail(b, "candidate retirement archive metadata record is invalid")
        source = _safe_relative_or_fail(b, record.get("source"), "candidate retirement metadata source")
        relative = _safe_relative_or_fail(b, record.get("path"), "candidate retirement metadata path")
        if relative == RETIREMENT_RECORD_NAME or relative in archive_paths:
            _fail(b, "candidate retirement archive metadata has duplicate path")
        archive_paths.add(relative)
        _require_int(b, record.get("size"), f"candidate retirement metadata size {relative}")
        _require_sha256(b, record.get("sha256"), f"candidate retirement metadata digest {relative}")
        if not source:
            _fail(b, "candidate retirement metadata source is empty")
    if not any(
        record["source"] == "source/live-manifest.json"
        and record["path"] == "source/live-manifest.json"
        for record in metadata
    ):
        _fail(b, "candidate retirement archive omits the sealed source manifest")
    return {
        "state": state,
        "candidate": candidate,
        "output": output,
        "control_root": control_root,
        "build_root": build_root,
        "classification": classification,
        "candidate_files": candidate_files,
        "deletion_intent": deletion_intent,
        "current_receipt_sha256": manifest["current_receipt_sha256"],
        "current_provenance_sha256": manifest["current_provenance_sha256"],
        "candidate_receipt_sha256": manifest["candidate_receipt_sha256"],
        "candidate_marker_sha256": manifest["candidate_marker_sha256"],
        "candidate_artifact_inventory_sha256": manifest["candidate_artifact_inventory_sha256"],
        "metadata": metadata,
        "candidate_artifacts": artifacts,
        "attempt": dict(attempt),
        "archive_paths": archive_paths,
        "source_manifest_sha256": manifest["source_manifest_sha256"],
        "_raw_manifest": dict(manifest),
    }


def _validate_archive_contents(
    b: Any,
    archive: Path,
    manifest: Mapping[str, Any],
    *,
    require_pending: bool | None = None,
) -> dict[str, Any]:
    normalized = _validate_manifest_shape(
        b, archive, manifest, require_pending=require_pending
    )
    b._assert_safe_tree(archive, "candidate retirement archive")
    files, _directories = b._stage_tree_inventory(archive)
    expected_files = set(normalized["archive_paths"]) | {RETIREMENT_RECORD_NAME}
    if files != expected_files:
        _fail(b, f"candidate retirement archive file inventory differs: {archive.name}")
    for record in normalized["metadata"]:
        path = archive.joinpath(*PurePosixPath(record["path"]).parts)
        digest, size = _sha256_file(
            b, path, f"candidate retirement archive {record['path']}", b.MAX_SOURCE_BYTES
        )
        if digest != record["sha256"] or size != record["size"]:
            _fail(b, f"candidate retirement archive metadata changed: {record['path']}")

    source_record = next(
        record
        for record in normalized["metadata"]
        if record["source"] == "source/live-manifest.json"
    )
    source_path = archive.joinpath(*PurePosixPath(source_record["path"]).parts)
    source_document, source_bytes = b._read_json(
        source_path,
        "archived candidate live source manifest",
        64 * 1024 * 1024,
    )
    if b._sha256_bytes(source_bytes) != normalized["source_manifest_sha256"]:
        _fail(b, "archived candidate source manifest digest differs")
    b._validate_live_manifest(source_document)

    marker_record = next(
        record for record in normalized["metadata"] if record["source"] == f"candidate/{b.PACKAGE_CANDIDATE_MARKER}"
    )
    marker_path = archive.joinpath(*PurePosixPath(marker_record["path"]).parts)
    marker, marker_bytes = b._read_json(
        marker_path, "archived candidate owner marker", 16 * 1024
    )
    if (
        marker.get("schema") != b.PACKAGE_CANDIDATE_SCHEMA
        or marker.get("state") != "ready"
        or marker.get("candidate") != str(normalized["candidate"])
        or marker.get("package_root") != str(normalized["output"])
        or marker.get("build_root") != str(normalized["build_root"])
        or marker.get("cargo_profile") != b.BACKEND_CARGO_PROFILE
        or marker.get("artifact_inventory_sha256") != manifest["candidate_artifact_inventory_sha256"]
        or b._sha256_bytes(marker_bytes) != manifest["candidate_marker_sha256"]
    ):
        _fail(b, "archived candidate owner marker is not receipt-bound")

    receipt_record = next(
        record
        for record in normalized["metadata"]
        if record["source"] == "candidate/backend-build-receipt.json"
    )
    receipt_path = archive.joinpath(*PurePosixPath(receipt_record["path"]).parts)
    receipt, receipt_bytes = b._read_json(
        receipt_path, "archived candidate build receipt", 8 * 1024 * 1024
    )
    if (
        receipt.get("schema") != b.RECEIPT_SCHEMA
        or receipt.get("state") != "succeeded"
        or b._sha256_bytes(receipt_bytes) != manifest["candidate_receipt_sha256"]
        or receipt.get("artifacts") != manifest["candidate_artifacts"]
    ):
        _fail(b, "archived candidate receipt is not inventory-bound")
    receipt_source = receipt.get("source")
    if (
        not isinstance(receipt_source, Mapping)
        or receipt_source.get("manifest_sha256")
        != manifest["source_manifest_sha256"]
    ):
        _fail(b, "archived candidate receipt is not source-manifest-bound")
    toolchain = _candidate_toolchain(b, receipt)
    cargo_profile = marker.get("cargo_profile")
    if not b._package_matches_fresh_live_manifest(
        receipt,
        source_path,
        toolchain,
        cargo_profile,
    ):
        _fail(b, "archived candidate receipt does not match its sealed source manifest")

    inventory_record = next(
        record
        for record in normalized["metadata"]
        if record["source"] == "generated/artifact-inventory.json"
    )
    inventory_path = archive.joinpath(*PurePosixPath(inventory_record["path"]).parts)
    inventory, _inventory_bytes = b._read_json(
        inventory_path, "archived candidate artifact inventory", 8 * 1024 * 1024
    )
    if (
        inventory.get("schema") != RETIREMENT_ARTIFACT_INVENTORY_SCHEMA
        or inventory.get("candidate") != str(normalized["candidate"])
        or inventory.get("artifacts") != manifest["candidate_artifacts"]
        or b._sha256_bytes(b._canonical(manifest["candidate_artifacts"]))
        != manifest["candidate_artifact_inventory_sha256"]
    ):
        _fail(b, "archived candidate artifact inventory is not bound")

    attempt_record = next(
        record
        for record in normalized["metadata"]
        if record["source"] == "attempt/attempt.json"
    )
    attempt_path = archive.joinpath(*PurePosixPath(attempt_record["path"]).parts)
    attempt, attempt_bytes = b._read_json(
        attempt_path,
        "archived Make attempt receipt",
        b.FAILED_MAKE_RECEIPT_BYTES_LIMIT,
    )
    if (
        attempt.get("schema") != b.FAILED_MAKE_SCHEMA
        or attempt.get("state") != "succeeded"
        or attempt.get("candidate") != str(normalized["candidate"])
        or attempt.get("build_root") != str(normalized["build_root"])
        or attempt.get("exit_code") != 0
        or b._sha256_bytes(attempt_bytes) != normalized["attempt"]["receipt_sha256"]
        or attempt.get("log_sha256") != normalized["attempt"]["log_sha256"]
        or attempt.get("log_size") != normalized["attempt"]["log_size"]
        or attempt.get("log_retired") != normalized["attempt"]["log_retired"]
    ):
        _fail(b, "archived Make attempt receipt is not bound")
    if not attempt.get("log_retired"):
        attempt_log_source = "attempt/" + b.FAILED_MAKE_LOG_NAME
        candidate_log_source = "candidate/" + b.FAILED_MAKE_LOG_NAME
        if not any(
            record["source"] in {attempt_log_source, candidate_log_source}
            and record["sha256"] == normalized["attempt"]["log_sha256"]
            and record["size"] == normalized["attempt"]["log_size"]
            for record in normalized["metadata"]
        ):
            _fail(b, "archived Make attempt has no archived external log")

    if manifest.get("state") in {"succeeded", "historical"}:
        candidate = normalized["candidate"]
        if candidate.exists() or candidate.is_symlink():
            _fail(b, "completed candidate retirement still has a candidate directory")
    return normalized


def _scan_archives(b: Any, archive_root: Path) -> list[tuple[Path, dict[str, Any]]]:
    try:
        entries = tuple(sorted(islice(archive_root.iterdir(), RETIREMENT_MAX_ARCHIVES + 1), key=lambda path: path.name))
    except FileNotFoundError:
        return []
    except OSError as error:
        _fail(b, f"cannot inspect candidate retirement namespace: {error}")
    if len(entries) > RETIREMENT_MAX_ARCHIVES:
        _fail(b, "candidate retirement archive count exceeds its bound")
    result: list[tuple[Path, dict[str, Any]]] = []
    total_bytes = 0
    for archive in entries:
        if not RETIREMENT_ARCHIVE_NAME_RE.fullmatch(archive.name):
            _fail(b, f"candidate retirement namespace has an unknown entry: {archive.name}")
        manifest, _raw = _read_archive_manifest(b, archive)
        normalized = _validate_archive_contents(b, archive, manifest)
        total_bytes += _tree_size(b, archive)
        if total_bytes > RETIREMENT_MAX_BYTES:
            _fail(b, "candidate retirement archive bytes exceed their bound")
        result.append((archive, normalized))
    return result


def _same_current_package(
    b: Any,
    output: Path,
    current: tuple[dict[str, Any], bytes, dict[str, Any]],
    name: str,
) -> tuple[dict[str, Any], bytes, dict[str, Any]]:
    if current is None or len(current) != 3:
        _fail(b, f"{name} has no validated current package")
    observed = b._validated_package(
        output,
        name,
        exclude_development_control=True,
    )
    if observed[1] != current[1] or observed[2] != current[2]:
        _fail(b, f"{name} changed during candidate retirement")
    return observed


def _current_provenance_hash(
    b: Any,
    output: Path,
    current_receipt: Mapping[str, Any],
    current_receipt_sha256: str,
) -> str:
    output = _absolute(b, output, "current package root")
    receipt_path = output / "backend-build-receipt.json"
    if current_receipt.get("schema") != b.RECEIPT_SCHEMA:
        _fail(b, "current package receipt schema is not canonical")
    artifacts = current_receipt.get("artifacts")
    if not isinstance(artifacts, list) or any(not isinstance(item, Mapping) for item in artifacts):
        _fail(b, "current package receipt inventory is invalid")
    binary_hashes = {
        str(record["path"])[len("bin/"):]: record["sha256"]
        for record in artifacts
        if isinstance(record, Mapping)
        and isinstance(record.get("path"), str)
        and record["path"].startswith("bin/")
        and isinstance(record.get("sha256"), str)
    }
    path = Path(b.PROVENANCE_PATH)
    try:
        provenance, raw = b._read_json(path, "current runtime provenance", 8 * 1024 * 1024)
    except (b.BackendBuildError, OSError):
        _fail(b, "current runtime provenance is unavailable")
    if (
        provenance.get("schema") != "fullmag.docker-all-image.v1"
        or provenance.get("state") != "succeeded"
        or provenance.get("package_root") != str(output)
        or provenance.get("backend_build_receipt") != str(receipt_path)
        or provenance.get("backend_build_receipt_schema") != b.RECEIPT_SCHEMA
        or provenance.get("build_receipt_sha256") != current_receipt_sha256
        or provenance.get("artifacts") != artifacts
        or provenance.get("binary_hashes") != binary_hashes
    ):
        _fail(b, "current runtime provenance is not bound to the exact retained package")
    return b._sha256_bytes(raw)


def _candidate_matches_spec(b: Any, spec: ReadyCandidateSpec) -> None:
    try:
        marker = b._validate_candidate_marker(
            spec.candidate, spec.output, spec.build_root, state="ready"
        )
        if marker != spec.marker:
            _fail(b, "ready candidate marker changed before retirement")
        records = _candidate_file_records(b, spec.candidate, spec.receipt)
        if records != spec.candidate_files:
            _fail(b, "ready candidate inventory changed before retirement")
        attempt_record = b._read_failed_make_attempt(spec.build_root, spec.candidate)
        if attempt_record is None or attempt_record[0] != spec.attempt:
            _fail(b, "ready candidate Make attempt changed before retirement")
    except (b.BackendBuildError, OSError):
        raise


def _archive_target(b: Any, spec: ReadyCandidateSpec) -> Path:
    suffix = spec.candidate.name.removeprefix(".backend-package-candidate-")
    if not suffix or not re.fullmatch(r"[A-Za-z0-9._-]+", suffix):
        _fail(b, "candidate retirement suffix is unsafe")
    return _retirement_root(b) / (
        f"{RETIREMENT_ARCHIVE_PREFIX}{suffix}-{spec.candidate_receipt_sha256[:16]}"
    )


def _read_prepared_source_manifest(
    b: Any,
    candidate: Path,
    output: Path,
    control_root: Path,
    build_root: Path,
    candidate_receipt_sha256: str,
    expected_sha256: str,
) -> tuple[dict[str, Any], bytes]:
    """Recover the old manifest only from a sealed, non-authorizing archive."""

    # The candidate receipt digest gives a stable archive name even before a
    # ReadyCandidateSpec exists.
    suffix = candidate.name.removeprefix(".backend-package-candidate-")
    target = _retirement_root(b) / (
        f"{RETIREMENT_ARCHIVE_PREFIX}{suffix}-{candidate_receipt_sha256[:16]}"
    )
    try:
        metadata = target.lstat()
    except FileNotFoundError:
        _fail(b, "candidate source manifest was overwritten and no prepared archive exists")
    except OSError as error:
        _fail(b, f"cannot inspect prepared candidate retirement archive: {error}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        _fail(b, "prepared candidate retirement archive is unsafe")
    manifest, _raw = _read_archive_manifest(b, target)
    normalized = _validate_archive_contents(b, target, manifest)
    if normalized["state"] != "prepared":
        _fail(b, "candidate source manifest fallback is not a prepared archive")
    if (
        normalized["candidate"] != candidate
        or normalized["output"] != output
        or normalized["control_root"] != control_root
        or normalized["build_root"] != build_root
        or normalized["candidate_receipt_sha256"] != candidate_receipt_sha256
        or normalized["source_manifest_sha256"] != expected_sha256
    ):
        _fail(b, "prepared candidate source manifest binding differs")
    source_path = target / "source" / "live-manifest.json"
    document, raw = b._read_json(
        source_path,
        "prepared candidate live source manifest",
        64 * 1024 * 1024,
    )
    if b._sha256_bytes(raw) != expected_sha256:
        _fail(b, "prepared candidate source manifest digest differs")
    b._validate_live_manifest(document)
    return document, raw


def _ensure_prepared_archive(b: Any, spec: ReadyCandidateSpec) -> Path:
    """Seal candidate evidence and the old live manifest before fresh capture."""

    archive_root = _retirement_root(b)
    try:
        metadata = archive_root.lstat()
    except FileNotFoundError:
        existing: list[tuple[Path, dict[str, Any]]] = []
        metadata = None
    except OSError as error:
        _fail(b, f"cannot inspect candidate retirement namespace: {error}")
    if metadata is not None:
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            _fail(b, "candidate retirement namespace is not a directory")
        existing = _scan_archives(b, archive_root)
    target = _archive_target(b, spec)
    for archive, normalized in existing:
        if archive != target:
            continue
        if normalized["state"] != "prepared":
            _fail(b, "candidate already has an actioned retirement archive")
        if (
            normalized["candidate"] != spec.candidate
            or normalized["output"] != spec.output
            or normalized["control_root"] != spec.control_root
            or normalized["build_root"] != spec.build_root
            or normalized["candidate_receipt_sha256"] != spec.candidate_receipt_sha256
            or normalized["candidate_marker_sha256"] != spec.marker_sha256
            or normalized["candidate_artifact_inventory_sha256"]
            != spec.artifact_inventory_sha256
            or normalized["source_manifest_sha256"] != spec.source_manifest_sha256
        ):
            _fail(b, "prepared candidate retirement binding differs")
        _candidate_matches_spec(b, spec)
        return archive
    if len(existing) >= RETIREMENT_MAX_ARCHIVES:
        _fail(b, "candidate retirement archive count budget is exhausted")
    archive, _manifest = _create_archive(b, spec)
    return archive


def _candidate_toolchain(b: Any, receipt: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the immutable toolchain mapping before using it as an input."""

    toolchain = receipt.get("toolchain")
    required = {
        "image_id",
        "dependency_manifest_sha256",
        "dependency_schema",
        "actual_source_commits",
    }
    if not isinstance(toolchain, Mapping) or set(toolchain) != required:
        _fail(b, "ready candidate toolchain identity is incomplete or unexpected")
    image_id = toolchain.get("image_id")
    image_re = getattr(b, "IMAGE_RE", re.compile(r"^sha256:[0-9a-f]{64}$"))
    if not isinstance(image_id, str) or image_re.fullmatch(image_id) is None:
        _fail(b, "ready candidate toolchain image identity is invalid")
    _require_sha256(
        b,
        toolchain.get("dependency_manifest_sha256"),
        "ready candidate dependency manifest digest",
    )
    if toolchain.get("dependency_schema") != "fullmag.docker.fem-gpu-dependencies.v1":
        _fail(b, "ready candidate dependency manifest schema is unsupported")
    commits = toolchain.get("actual_source_commits")
    required_commits = frozenset(("mfem", "libceed", "hypre", "petsc", "slepc"))
    allowed_commits = required_commits | {"umpire"}
    if (
        not isinstance(commits, Mapping)
        or not required_commits.issubset(commits)
        or not set(commits).issubset(allowed_commits)
        or any(
            not isinstance(commits[key], str) or not commits[key]
            for key in required_commits
        )
        or (
            "umpire" in commits
            and commits["umpire"] is not None
            and (
                not isinstance(commits["umpire"], str)
                or not commits["umpire"]
            )
        )
    ):
        _fail(b, "ready candidate dependency source commits are invalid")
    return dict(toolchain)


def _validate_candidate_source_binding(
    b: Any,
    spec: ReadyCandidateSpec,
    archive: Path,
) -> None:
    """Bind the receipt's source/native/build identity to sealed old input."""

    cargo_profile = spec.marker.get("cargo_profile")
    if cargo_profile != getattr(b, "BACKEND_CARGO_PROFILE", None):
        _fail(b, "ready candidate Cargo profile identity differs")
    toolchain = _candidate_toolchain(b, spec.receipt)
    manifest_path = archive / "source" / "live-manifest.json"
    if not b._package_matches_fresh_live_manifest(
        spec.receipt,
        manifest_path,
        toolchain,
        cargo_profile,
    ):
        _fail(b, "ready candidate receipt does not match its sealed source manifest")


def _archive_copy(
    b: Any,
    source: Path,
    target: Path,
    source_label: str,
    expected_size: int | None = None,
    *,
    shared_identity: tuple[int, int] | None = None,
) -> tuple[str, int]:
    if expected_size is not None:
        metadata = source.lstat()
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or (
                metadata.st_nlink != 1
                if shared_identity is None
                else (
                    metadata.st_nlink < 2
                    or (metadata.st_dev, metadata.st_ino) != shared_identity
                    or bool(metadata.st_mode & 0o222)
                )
            )
            or metadata.st_size != expected_size
        ):
            _fail(b, f"{source_label} changed before archive reservation")
    digest, size = b._copy_regular_file_fsync(source, target, source_label)
    if shared_identity is not None:
        after = source.lstat()
        if (
            stat.S_ISLNK(after.st_mode)
            or not stat.S_ISREG(after.st_mode)
            or after.st_nlink < 2
            or (after.st_dev, after.st_ino) != shared_identity
            or bool(after.st_mode & 0o222)
        ):
            _fail(b, f"{source_label} changed identity during shared archive copy")
    return digest, size


def _archive_bytes(
    b: Any,
    data: bytes,
    target: Path,
    source_label: str,
) -> tuple[str, int]:
    """Publish an already validated record without rereading an overwritten path."""

    b._ensure_directory(target.parent, f"{source_label} destination parent")
    if target.exists() or target.is_symlink():
        _fail(b, f"{source_label} destination already exists")
    temporary = target.parent / f".{target.name}.{os.getpid()}.tmp"
    digest = b._sha256_bytes(data)
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o640,
        )
        try:
            view = memoryview(data)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    _fail(b, f"short write while archiving {source_label}")
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, target)
        observed, metadata = b._sha256_file(target, source_label, 64 * 1024 * 1024)
        if observed != digest or metadata.st_size != len(data):
            _fail(b, f"{source_label} changed during archive readback")
        b._fsync_directory(target.parent, f"{source_label} staging directory")
        return digest, len(data)
    except OSError as error:
        _fail(b, f"cannot archive {source_label}: {error}")
    finally:
        temporary.unlink(missing_ok=True)


def _reserve_archive_bytes(
    b: Any,
    existing_size: int,
    staging_bytes: int,
    reserved_size: int,
    amount: int,
    source_label: str,
) -> int:
    if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
        _fail(b, f"{source_label} size is invalid")
    projected = reserved_size + amount
    if existing_size + projected > RETIREMENT_MAX_BYTES:
        _fail(b, f"candidate retirement archive byte budget is exhausted before {source_label}")
    if staging_bytes + projected > RETIREMENT_MAX_STAGING_BYTES:
        _fail(b, f"candidate retirement staging byte budget is exhausted before {source_label}")
    return projected


def _create_archive(
    b: Any,
    spec: ReadyCandidateSpec,
) -> tuple[Path, dict[str, Any]]:
    archive_root = _retirement_root(b)
    staging_root = _retirement_staging_root(b)
    b._ensure_directory(archive_root, "candidate retirement namespace")
    b._ensure_directory(staging_root, "candidate retirement staging namespace")
    existing = _scan_archives(b, archive_root)
    staging_entries, staging_bytes = _scan_staging(b, staging_root)
    existing_size = sum(_tree_size(b, archive) for archive, _ in existing)
    if len(staging_entries) >= RETIREMENT_MAX_STAGING_ENTRIES:
        _fail(b, "candidate retirement staging entry limit is exhausted")
    if len(existing) >= RETIREMENT_MAX_ARCHIVES:
        _fail(b, "candidate retirement archive count budget is exhausted")
    target = _archive_target(b, spec)
    if target.exists() or target.is_symlink():
        _fail(b, "candidate retirement archive already exists")
    staging_suffix = target.name.removeprefix(RETIREMENT_ARCHIVE_PREFIX)
    temporary = Path(
        tempfile.mkdtemp(
            prefix=f".backend-package-candidate-staging-{staging_suffix}-",
            dir=staging_root,
        )
    )
    metadata_records: list[dict[str, Any]] = []
    copied_archive_paths: dict[str, tuple[str, int]] = {}
    reserved_size = 0

    def reserve(amount: int, source_label: str) -> None:
        nonlocal reserved_size
        reserved_size = _reserve_archive_bytes(
            b,
            existing_size,
            staging_bytes,
            reserved_size,
            amount,
            source_label,
        )

    def copy_source(
        source: Path,
        source_name: str,
        archive_relative: str,
        expected_size: int,
        expected_digest: str,
        shared_identity: tuple[int, int] | None = None,
    ) -> None:
        if archive_relative in copied_archive_paths:
            digest, size = copied_archive_paths[archive_relative]
            observed_digest, observed_size = _sha256_file(
                b, source, source_name, b.MAX_SOURCE_BYTES
            )
            if (
                observed_digest != digest
                or observed_size != size
                or observed_digest != expected_digest
                or observed_size != expected_size
            ):
                _fail(b, f"{source_name} differs from the archived duplicate")
            # The successful Make attempt log is normally the same bytes as
            # the candidate's published diagnostic log.  Keep one archived
            # copy; the attempt receipt still binds its digest and size.
            if any(record["path"] == archive_relative for record in metadata_records):
                return
        else:
            reserve(expected_size, source_name)
            target_path = temporary.joinpath(*PurePosixPath(archive_relative).parts)
            digest, size = _archive_copy(
                b,
                source,
                target_path,
                source_name,
                expected_size,
                shared_identity=shared_identity,
            )
            if digest != expected_digest or size != expected_size:
                _fail(b, f"{source_name} differs from its recorded inventory")
            copied_archive_paths[archive_relative] = (digest, size)
        metadata_records.append(
            {
                "source": source_name,
                "path": archive_relative,
                "size": size,
                "sha256": digest,
            }
        )

    try:
        artifact_paths = {str(record["path"]) for record in spec.artifacts}
        shared_copy_paths: set[str] = set()
        for record in spec.candidate_files:
            relative = str(record["path"])
            if record["role"] == "payload":
                continue
            metadata = spec.candidate.joinpath(*PurePosixPath(relative).parts).lstat()
            if metadata.st_nlink > 1:
                if relative not in artifact_paths:
                    _fail(b, f"candidate retirement metadata is multiply linked: {relative}")
                shared_copy_paths.add(relative)

        with _shared_candidate_artifact_proof(
            b, spec.candidate, spec.receipt, shared_copy_paths
        ) as shared_links:
            for record in spec.candidate_files:
                relative = str(record["path"])
                role = record["role"]
                if role == "payload":
                    continue
                source = spec.candidate.joinpath(*PurePosixPath(relative).parts)
                if role == "marker":
                    archive_relative = "candidate-owner.json"
                elif role == "receipt":
                    archive_relative = "candidate-records/backend-build-receipt.json"
                elif role == "log":
                    archive_relative = f"candidate-logs/{relative}"
                else:
                    archive_relative = f"candidate-metadata/{relative}"
                copy_source(
                    source,
                    f"candidate/{relative}",
                    archive_relative,
                    int(record["size"]),
                    str(record["sha256"]),
                    shared_identity=shared_links.get(relative),
                )

        reserve(len(spec.source_manifest_bytes), "candidate live source manifest")
        source_digest, source_size = _archive_bytes(
            b,
            spec.source_manifest_bytes,
            temporary / "source" / "live-manifest.json",
            "candidate live source manifest",
        )
        if (
            source_digest != spec.source_manifest_sha256
            or source_size != len(spec.source_manifest_bytes)
        ):
            _fail(b, "candidate live source manifest differs from its reservation")
        metadata_records.append(
            {
                "source": "source/live-manifest.json",
                "path": "source/live-manifest.json",
                "size": source_size,
                "sha256": source_digest,
            }
        )

        inventory_path = temporary / "candidate-records" / "artifact-inventory.json"
        inventory_document = {
            "schema": RETIREMENT_ARTIFACT_INVENTORY_SCHEMA,
            "candidate": str(spec.candidate),
            "artifacts": list(spec.artifacts),
        }
        inventory_bytes = b._canonical(inventory_document)
        reserve(len(inventory_bytes), "candidate artifact inventory")
        b._write_json(
            inventory_path,
            inventory_document,
            "candidate retirement artifact inventory",
        )
        inventory_digest, inventory_size = _sha256_file(
            b,
            inventory_path,
            "candidate retirement artifact inventory",
            8 * 1024 * 1024,
        )
        metadata_records.append(
            {
                "source": "generated/artifact-inventory.json",
                "path": "candidate-records/artifact-inventory.json",
                "size": inventory_size,
                "sha256": inventory_digest,
            }
        )

        attempt_source_name = "attempt/attempt.json"
        copy_source(
            spec.attempt_receipt,
            attempt_source_name,
            "make-attempt/attempt.json",
            len(spec.attempt_receipt_bytes),
            b._sha256_bytes(spec.attempt_receipt_bytes),
        )
        if not spec.attempt.get("log_retired"):
            if not spec.attempt_log.exists() or spec.attempt_log.is_symlink():
                _fail(b, "candidate retirement Make log disappeared before archive")
            candidate_log_archive = next(
                (
                    record["path"]
                    for record in metadata_records
                    if record["source"] == f"candidate/{b.FAILED_MAKE_LOG_NAME}"
                ),
                None,
            )
            copy_source(
                spec.attempt_log,
                "attempt/" + b.FAILED_MAKE_LOG_NAME,
                candidate_log_archive or "make-attempt/" + b.FAILED_MAKE_LOG_NAME,
                int(spec.attempt["log_size"]),
                str(spec.attempt["log_sha256"]),
            )

        b._fsync_owned_tree(temporary, "candidate retirement archive staging")
        manifest: dict[str, Any] = {
            "schema": RETIREMENT_SCHEMA,
            "state": "prepared",
            "archive": str(target),
            "candidate": str(spec.candidate),
            "output": str(spec.output),
            "control_root": str(spec.control_root),
            "build_root": str(spec.build_root),
            "candidate_name": spec.candidate.name,
            "classification": None,
            "created_at_ns": time.time_ns(),
            "candidate_marker_sha256": spec.marker_sha256,
            "candidate_receipt_sha256": spec.candidate_receipt_sha256,
            "candidate_artifact_inventory_sha256": spec.artifact_inventory_sha256,
            "source_manifest_sha256": spec.source_manifest_sha256,
            "candidate_artifacts": list(spec.artifacts),
            "candidate_files": [dict(record) for record in spec.candidate_files],
            "deletion_intent": [],
            "current_receipt_sha256": None,
            "current_provenance_sha256": None,
            "action_at_ns": None,
            "completed_at_ns": None,
            "payload_deleted": False,
            "marker_deleted": False,
            "attempt": {
                "receipt_sha256": b._sha256_bytes(spec.attempt_receipt_bytes),
                "state": spec.attempt["state"],
                "exit_code": spec.attempt["exit_code"],
                "log_sha256": spec.attempt["log_sha256"],
                "log_size": spec.attempt["log_size"],
                "log_retired": spec.attempt["log_retired"],
            },
            "metadata": metadata_records,
        }
        record_bytes = b._canonical(manifest)
        reserve(len(record_bytes), "candidate retirement record")
        b._write_json(
            temporary / RETIREMENT_RECORD_NAME,
            manifest,
            "candidate retirement record",
        )
        b._fsync_owned_tree(temporary, "candidate retirement archive staging")
        staged_size = _tree_size(b, temporary)
        if staged_size != reserved_size:
            _fail(b, "candidate retirement staging differs from its reservations")
        staged_manifest, staged_bytes = b._read_json(
            temporary / RETIREMENT_RECORD_NAME,
            "staged candidate retirement record",
            4 * 1024 * 1024,
        )
        if staged_bytes != record_bytes or staged_manifest != manifest:
            _fail(b, "candidate retirement record changed before publication")
        # Validate the same metadata against its physical staging location
        # before the atomic rename makes it visible as a final archive. Only
        # this in-memory path binding changes; the durable record pins target.
        staged_manifest = dict(staged_manifest)
        staged_manifest["archive"] = str(temporary)
        _validate_archive_contents(b, temporary, staged_manifest)
        os.rename(temporary, target)
        temporary = Path()
        b._fsync_directory(staging_root, "candidate retirement staging namespace")
        b._fsync_directory(archive_root, "candidate retirement namespace")
        manifest, _ = _read_archive_manifest(b, target)
        _validate_archive_contents(b, target, manifest)
        return target, manifest
    except (b.BackendBuildError, OSError):
        if temporary != Path() and temporary.exists():
            try:
                b._remove_owned_tree(temporary)
            except (b.BackendBuildError, OSError):
                pass
        raise


def _delete_pending_candidate(
    b: Any,
    archive: Path,
    normalized: Mapping[str, Any],
) -> None:
    candidate = normalized["candidate"]
    expected = {
        str(record["path"]): record for record in normalized["candidate_files"]
    }
    if candidate.exists() or candidate.is_symlink():
        b._assert_safe_tree(candidate, "pending candidate retirement candidate")
        files, directories = b._stage_tree_inventory(candidate)
        if not files.issubset(expected):
            _fail(b, "pending candidate retirement found an unknown candidate file")
        allowed_dirs: set[str] = set()
        for relative in expected:
            parts = PurePosixPath(relative).parts
            allowed_dirs.update(
                PurePosixPath(*parts[:index]).as_posix()
                for index in range(1, len(parts))
            )
        if not directories.issubset(allowed_dirs):
            _fail(b, "pending candidate retirement found an unknown candidate directory")
        archived_receipt, archived_receipt_bytes = _read_archived_candidate_receipt(
            b, archive, normalized
        )
        if (
            b._sha256_bytes(archived_receipt_bytes)
            != normalized["candidate_receipt_sha256"]
            or archived_receipt.get("artifacts") != normalized["candidate_artifacts"]
        ):
            _fail(b, "pending candidate archive receipt differs from its artifact inventory")
        artifact_paths = {
            str(record["path"]) for record in normalized["candidate_artifacts"]
        }
        linked_paths: set[str] = set()
        for relative in files:
            metadata = candidate.joinpath(*PurePosixPath(relative).parts).lstat()
            if metadata.st_nlink > 1:
                if relative not in artifact_paths:
                    _fail(b, f"pending candidate non-artifact file is multiply linked: {relative}")
                linked_paths.add(relative)

        with _shared_candidate_artifact_proof(
            b, candidate, archived_receipt, linked_paths
        ) as shared_links:
            for relative in sorted(files):
                record = expected[relative]
                path = candidate.joinpath(*PurePosixPath(relative).parts)
                metadata = path.lstat()
                if relative in shared_links:
                    if (
                        metadata.st_nlink < 2
                        or (metadata.st_dev, metadata.st_ino) != shared_links[relative]
                        or metadata.st_mode & 0o222
                    ):
                        _fail(b, f"pending shared candidate artifact changed: {relative}")
                elif metadata.st_nlink != 1:
                    _fail(b, f"pending candidate file is multiply linked: {relative}")
                observed_mode = "100755" if metadata.st_mode & 0o111 else "100644"
                if observed_mode != record["mode"]:
                    _fail(b, f"pending candidate file mode changed: {relative}")
                if relative in shared_links:
                    digest, hashed_metadata = b._sha256_file(
                        path,
                        f"pending candidate retirement file {relative}",
                        b.MAX_SOURCE_BYTES,
                        package_artifact=True,
                    )
                    size = int(hashed_metadata.st_size)
                    if (
                        (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mode)
                        != (
                            hashed_metadata.st_dev,
                            hashed_metadata.st_ino,
                            hashed_metadata.st_size,
                            hashed_metadata.st_mode,
                        )
                    ):
                        _fail(b, f"pending shared artifact changed identity while hashing: {relative}")
                else:
                    digest, size = _sha256_file(
                        b,
                        path,
                        f"pending candidate retirement file {relative}",
                        b.MAX_SOURCE_BYTES,
                    )
                after = path.lstat()
                if (
                    (metadata.st_dev, metadata.st_ino) != (after.st_dev, after.st_ino)
                    or metadata.st_size != after.st_size
                    or metadata.st_mode != after.st_mode
                    or digest != record["sha256"]
                    or size != record["size"]
                ):
                    _fail(b, f"pending candidate file changed: {relative}")
            marker = b.PACKAGE_CANDIDATE_MARKER
            if marker not in files and (files - {marker}):
                _fail(b, "pending candidate marker was removed before payload")
            for relative in sorted(
                (files - {marker}), key=lambda value: (value.count("/"), value), reverse=True
            ):
                b._remove_owned_tree(candidate.joinpath(*PurePosixPath(relative).parts))
            for relative in sorted(
                directories, key=lambda value: (value.count("/"), value), reverse=True
            ):
                directory = candidate.joinpath(*PurePosixPath(relative).parts)
                try:
                    directory.rmdir()
                except OSError as error:
                    _fail(b, f"pending candidate payload directory is not empty: {error}")
            b._fsync_directory(candidate, "pending candidate directory")
            if marker in files:
                marker_path = candidate / marker
                marker_record = expected[marker]
                digest, size = _sha256_file(
                    b, marker_path, "pending candidate owner marker", 16 * 1024
                )
                if digest != marker_record["sha256"] or size != marker_record["size"]:
                    _fail(b, "pending candidate owner marker changed")
                b._remove_owned_tree(marker_path)
                b._fsync_directory(candidate, "pending candidate directory")
            try:
                candidate.rmdir()
            except OSError as error:
                _fail(b, f"pending candidate directory cannot be removed: {error}")
            b._fsync_directory(candidate.parent, "candidate package candidate directory")

    updated = dict(manifest_from_normalized(normalized))
    updated.update(
        {
            "state": "succeeded",
            "completed_at_ns": time.time_ns(),
            "payload_deleted": True,
            "marker_deleted": True,
        }
    )
    b._write_json(
        archive / RETIREMENT_RECORD_NAME,
        updated,
        "candidate retirement record completion",
    )
    b._fsync_directory(archive, "candidate retirement archive")
    _validate_archive_contents(b, archive, updated, require_pending=False)


def manifest_from_normalized(normalized: Mapping[str, Any]) -> dict[str, Any]:
    """Recover the original record fields retained by normalization."""

    # ``_validate_manifest_shape`` intentionally returns only fields needed by
    # recovery.  The caller re-reads the raw manifest before invoking this
    # function; this helper is replaced by that raw document in
    # ``_finish_pending_archive`` below.  Keeping this function explicit makes
    # accidental synthesis of a new retirement record impossible.
    raw = normalized.get("_raw_manifest")
    if not isinstance(raw, dict):
        raise ValueError("pending retirement has no raw manifest")
    return dict(raw)


def _finish_pending_archive(
    b: Any,
    archive: Path,
    normalized: Mapping[str, Any],
    current: tuple[dict[str, Any], bytes, dict[str, Any]],
    output: Path,
    build_root: Path,
) -> bool:
    if normalized["build_root"] != build_root:
        _fail(b, "pending candidate retirement build root differs")
    current_now = _same_current_package(b, output, current, "pending retirement current package")
    current_sha = b._sha256_bytes(current_now[1])
    if current_sha != normalized.get("current_receipt_sha256"):
        _fail(b, "pending candidate retirement current package differs")
    current_provenance = _current_provenance_hash(
        b,
        output,
        current_now[0],
        current_sha,
    )
    if current_provenance != normalized.get("current_provenance_sha256"):
        _fail(b, "pending candidate retirement current provenance differs")
    raw_manifest, _ = _read_archive_manifest(b, archive)
    raw_normalized = dict(normalized)
    raw_normalized["_raw_manifest"] = raw_manifest
    _delete_pending_candidate(b, archive, raw_normalized)
    try:
        attempt = b._read_failed_make_attempt(
            Path(raw_manifest["build_root"]), Path(raw_manifest["candidate"])
        )
        if attempt is not None and not attempt[0].get("log_retired"):
            b._retire_make_log(attempt)
            return True
    except (b.BackendBuildError, OSError):
        # The archive is complete and the candidate is gone.  Keep the
        # external diagnostic when its live attempt record cannot be reopened.
        pass
    return False


def _read_archived_candidate_receipt(
    b: Any,
    archive: Path,
    normalized: Mapping[str, Any],
) -> tuple[dict[str, Any], bytes]:
    record = next(
        record
        for record in normalized["metadata"]
        if record["source"] == "candidate/backend-build-receipt.json"
    )
    path = archive.joinpath(*PurePosixPath(record["path"]).parts)
    return b._read_json(
        path,
        "archived candidate build receipt",
        8 * 1024 * 1024,
    )


def _mark_prepared_archive_historical(
    b: Any,
    archive: Path,
    normalized: Mapping[str, Any],
    current: tuple[dict[str, Any], bytes, dict[str, Any]],
) -> RetirementResult:
    """Finalize a prepared archive after an already durable promotion."""

    if normalized["state"] != "prepared":
        _fail(b, "promoted candidate retirement archive was already actioned")
    if current is None:
        _fail(b, "promoted candidate retirement requires a verified current package")
    output = normalized["output"]
    control_root = normalized["control_root"]
    if b._read_rotation_journal(output, control_root) is not None:
        _fail(b, "promoted candidate retirement requires a cleared package rotation journal")
    current_now = _same_current_package(
        b, output, current, "promoted candidate current package"
    )
    current_sha = b._sha256_bytes(current_now[1])
    receipt, receipt_bytes = _read_archived_candidate_receipt(b, archive, normalized)
    if (
        current_sha != normalized["candidate_receipt_sha256"]
        or current_now[1] != receipt_bytes
        or list(normalized["candidate_artifacts"])
        != current_now[0].get("artifacts")
    ):
        _fail(b, "promoted candidate receipt or inventory is not exactly current")
    current_provenance = _current_provenance_hash(
        b,
        output,
        current_now[0],
        current_sha,
    )
    candidate = normalized["candidate"]
    if candidate.exists() or candidate.is_symlink():
        _fail(b, "promoted candidate has not been finalized by common publication")
    action_manifest = dict(normalized["_raw_manifest"])
    action_manifest.update(
        {
            "state": "historical",
            "classification": "promoted",
            "deletion_intent": [],
            "current_receipt_sha256": current_sha,
            "current_provenance_sha256": current_provenance,
            "action_at_ns": time.time_ns(),
            "completed_at_ns": time.time_ns(),
            "payload_deleted": False,
            "marker_deleted": True,
        }
    )
    b._write_json(
        archive / RETIREMENT_RECORD_NAME,
        action_manifest,
        "promoted candidate historical record",
    )
    b._fsync_directory(archive, "candidate retirement archive")
    _validate_archive_contents(b, archive, action_manifest)
    return RetirementResult(
        action="historical",
        classification="promoted",
        candidate=candidate,
        archive=archive,
        external_log_retired=False,
    )


def recover_pending_retirements(
    b: Any,
    output: Path,
    control_root: Path,
    build_root: Path,
    current: tuple[dict[str, Any], bytes, dict[str, Any]] | None,
) -> list[RetirementResult]:
    """Finish only durable pending archives; completed archives are historical."""

    output = _absolute(b, output, "backend output")
    control_root = _absolute(b, control_root, "backend package development control directory")
    build_root = _absolute(b, build_root, "backend build root")
    archive_root = _retirement_root(b)
    try:
        metadata = archive_root.lstat()
    except FileNotFoundError:
        # Do not create the technical namespace or read current provenance on
        # the common no-archive path.
        return []
    except OSError as error:
        _fail(b, f"cannot inspect candidate retirement namespace: {error}")
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        _fail(b, "candidate retirement namespace is not a directory")
    results: list[RetirementResult] = []
    for archive, normalized in _scan_archives(b, archive_root):
        if normalized["state"] == "prepared":
            # A prepared archive normally contains preservation evidence only.
            # If common publication already moved its candidate and the exact
            # candidate receipt is now current, finish the historical marker
            # without touching payloads.  Any mismatch leaves the evidence
            # readonly for the next start.
            candidate = normalized["candidate"]
            promotable = (
                current is not None
                and normalized["output"] == output
                and normalized["control_root"] == control_root
                and normalized["build_root"] == build_root
                and not candidate.exists()
                and not candidate.is_symlink()
                and b._read_rotation_journal(output, control_root) is None
            )
            if promotable:
                current_now = _same_current_package(
                    b, output, current, "prepared promotion current package"
                )
                current_sha = b._sha256_bytes(current_now[1])
                _receipt, receipt_bytes = _read_archived_candidate_receipt(
                    b, archive, normalized
                )
                promotable = (
                    current_sha == normalized["candidate_receipt_sha256"]
                    and current_now[1] == receipt_bytes
                    and list(normalized["candidate_artifacts"])
                    == current_now[0].get("artifacts")
                )
            if promotable:
                results.append(
                    _mark_prepared_archive_historical(
                        b, archive, normalized, current
                    )
                )
                continue
            results.append(
                RetirementResult(
                    action="prepared",
                    classification=None,
                    candidate=normalized["candidate"],
                    archive=archive,
                    external_log_retired=False,
                )
            )
            continue
        if normalized["state"] in {"succeeded", "historical"}:
            results.append(
                RetirementResult(
                    action="historical",
                    classification=normalized["classification"],
                    candidate=normalized["candidate"],
                    archive=archive,
                    external_log_retired=True,
                )
            )
            continue
        if normalized["output"] != output or normalized["control_root"] != control_root:
            _fail(b, "pending candidate retirement package binding differs")
        if current is None:
            _fail(b, "pending candidate retirement has no current package")
        log_retired = _finish_pending_archive(
            b, archive, normalized, current, output, build_root
        )
        results.append(
            RetirementResult(
                action="retired",
                classification=normalized["classification"],
                candidate=normalized["candidate"],
                archive=archive,
                external_log_retired=log_retired,
            )
        )
    return results


def retire_candidate(
    b: Any,
    spec: ReadyCandidateSpec,
    fresh_manifest: Path,
    toolchain: Mapping[str, Any],
    cargo_profile: str,
    current: tuple[dict[str, Any], bytes, dict[str, Any]] | None,
    *,
    required_native_contracts: tuple[str, ...] = (),
) -> RetirementResult:
    """Retire a stale/duplicate candidate or return it for normal rotation."""

    if not isinstance(spec, ReadyCandidateSpec):
        _fail(b, "candidate retirement received an invalid ready-candidate spec")
    _candidate_paths(b, spec.candidate, spec.output, spec.control_root, spec.build_root)
    if b._read_rotation_journal(spec.output, spec.control_root) is not None:
        _fail(b, "candidate retirement cannot run with a pending package rotation")
    current_now = None
    current_receipt_sha256: str | None = None
    current_provenance_sha256: str | None = None
    if current is not None:
        current_now = _same_current_package(
            b, spec.output, current, "candidate retirement current package"
        )
        current_receipt_sha256 = b._sha256_bytes(current_now[1])
        current_provenance_sha256 = _current_provenance_hash(
            b,
            spec.output,
            current_now[0],
            current_receipt_sha256,
        )
    _candidate_matches_spec(b, spec)
    fresh = b._package_matches_fresh_live_manifest(
        spec.receipt,
        _absolute(b, Path(fresh_manifest), "fresh live source manifest"),
        dict(toolchain),
        cargo_profile,
        **({"required_native_contracts": required_native_contracts} if required_native_contracts else {}),
    )
    # A rerun can produce a different receipt (fresh capture id/timestamp)
    # while publishing byte-identical artifacts.  Treat the package inventory
    # as the duplicate proof.  ``_candidate_paths`` has already proved that
    # the candidate directory is distinct from the current package root, and
    # the provenance guard binds the retained package to the current receipt
    # even when the two receipt bytes happen to be identical.
    duplicate = (
        current_now is not None
        and list(spec.artifacts) == current_now[0].get("artifacts")
    )
    if fresh and not duplicate:
        return RetirementResult(
            action="promote",
            classification=None,
            candidate=spec.candidate,
            archive=None,
            external_log_retired=False,
        )
    if current_now is None:
        _fail(b, "candidate retirement requires a verified current package")
    classification = "duplicate" if duplicate else "stale"
    archive = _archive_target(b, spec)
    try:
        manifest, _raw = _read_archive_manifest(b, archive)
    except (b.BackendBuildError, OSError):
        _fail(b, "candidate retirement has no sealed prepared archive")
    normalized = _validate_archive_contents(b, archive, manifest)
    if normalized["state"] != "prepared":
        _fail(b, "candidate retirement archive was already actioned")
    if (
        normalized["candidate"] != spec.candidate
        or normalized["output"] != spec.output
        or normalized["control_root"] != spec.control_root
        or normalized["build_root"] != spec.build_root
        or normalized["candidate_receipt_sha256"] != spec.candidate_receipt_sha256
        or normalized["candidate_marker_sha256"] != spec.marker_sha256
        or normalized["candidate_artifact_inventory_sha256"]
        != spec.artifact_inventory_sha256
        or normalized["source_manifest_sha256"] != spec.source_manifest_sha256
    ):
        _fail(b, "candidate retirement prepared archive binding differs")
    _candidate_matches_spec(b, spec)
    action_manifest = dict(manifest)
    action_manifest.update(
        {
            "state": "deletion-pending",
            "classification": classification,
            "deletion_intent": [str(record["path"]) for record in spec.candidate_files],
            "current_receipt_sha256": current_receipt_sha256,
            "current_provenance_sha256": current_provenance_sha256,
            "action_at_ns": time.time_ns(),
            "completed_at_ns": None,
            "payload_deleted": False,
            "marker_deleted": False,
        }
    )
    b._write_json(
        archive / RETIREMENT_RECORD_NAME,
        action_manifest,
        "candidate retirement deletion intent",
    )
    b._fsync_directory(archive, "candidate retirement archive")
    normalized = _validate_archive_contents(
        b, archive, action_manifest, require_pending=True
    )
    log_retired = _finish_pending_archive(
        b,
        archive,
        normalized,
        current_now,
        spec.output,
        spec.build_root,
    )
    return RetirementResult(
        action="retired",
        classification=classification,
        candidate=spec.candidate,
        archive=archive,
        external_log_retired=log_retired,
    )


def mark_promoted_archive_historical(
    b: Any,
    spec: ReadyCandidateSpec,
    current: tuple[dict[str, Any], bytes, dict[str, Any]],
) -> RetirementResult:
    """Seal a prepared archive as historical after common publication commits.

    The caller must invoke this only after the existing package rotation and
    candidate finalization are durable.  The hook proves that the current
    receipt bytes and artifact inventory are exactly the promoted candidate;
    it never performs the rotation or deletes candidate payload.
    """

    if not isinstance(spec, ReadyCandidateSpec):
        _fail(b, "promoted candidate retirement received an invalid ready-candidate spec")
    if current is None:
        _fail(b, "promoted candidate retirement requires a verified current package")
    _candidate_paths(b, spec.candidate, spec.output, spec.control_root, spec.build_root)
    archive = _archive_target(b, spec)
    manifest, _raw = _read_archive_manifest(b, archive)
    normalized = _validate_archive_contents(b, archive, manifest)
    if normalized["state"] != "prepared":
        _fail(b, "promoted candidate retirement archive was already actioned")
    if (
        normalized["candidate"] != spec.candidate
        or normalized["output"] != spec.output
        or normalized["control_root"] != spec.control_root
        or normalized["build_root"] != spec.build_root
        or normalized["candidate_receipt_sha256"] != spec.candidate_receipt_sha256
        or normalized["candidate_marker_sha256"] != spec.marker_sha256
        or normalized["candidate_artifact_inventory_sha256"]
        != spec.artifact_inventory_sha256
        or normalized["source_manifest_sha256"] != spec.source_manifest_sha256
    ):
        _fail(b, "promoted candidate retirement archive binding differs")
    return _mark_prepared_archive_historical(b, archive, normalized, current)
