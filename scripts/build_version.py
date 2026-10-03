#!/usr/bin/env python3
"""Generate one deterministic Fullmag development-version record.

The generator deliberately consumes a captured source identity instead of
asking Git for the current checkout.  A managed build can therefore stamp the
commit and snapshot that were actually bound to the build, even when the
working tree has moved on by the time packaging runs.

Only the explicitly requested output file is written.  The generated JSON is
canonical (sorted keys, stable indentation, and a trailing newline) so that
the same base version, timestamp, and source identity produce byte-identical
output.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 uses the build-system's tomli pin.
    import tomli as tomllib  # type: ignore[no-redef]

from typing import Any, Mapping, Sequence


SCHEMA = "fullmag.build-version.v1"
SOURCE_IDENTITY_SCHEMA = "fullmag.source-snapshot.v2"
WINDOWS_VERSION_EPOCH = date(2000, 1, 1)
PYTHON_PACKAGE_MANIFEST = Path("packages/fullmag-py/pyproject.toml")
_HEX40 = re.compile(r"[0-9a-f]{40}")
_HEX64 = re.compile(r"[0-9a-f]{64}")
_BASE_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
_EPOCH = re.compile(r"[0-9]+")


class BuildVersionError(ValueError):
    """Raised when version inputs cannot be converted to a safe record."""


@dataclass(frozen=True)
class SourceIdentity:
    """The immutable source identity captured for the build."""

    git_commit: str
    source_snapshot_sha256: str
    dirty: bool

    @property
    def git_short_commit(self) -> str:
        return self.git_commit[:12]

    @property
    def source_snapshot_short(self) -> str:
        return self.source_snapshot_sha256[:12]

    @property
    def worktree_state(self) -> str:
        return "dirty" if self.dirty else "clean"


def _require_lower_hex(value: Any, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise BuildVersionError(f"{label} must be lowercase hexadecimal")
    return value


def _require_bool(value: Any, label: str) -> bool:
    # `bool` is a subclass of `int`; type() keeps numeric JSON values out.
    if type(value) is not bool:
        raise BuildVersionError(f"{label} must be boolean")
    return value


def _read_json_object(path: Path, label: str) -> Mapping[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildVersionError(f"cannot read {label}: {path}") from error
    if not isinstance(document, dict):
        raise BuildVersionError(f"{label} must be a JSON object")
    return document


def _identity_canonical_bytes(value: object) -> bytes:
    """Return the compact canonical form used by source identity v2."""

    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _sha256_json(value: object) -> str:
    return hashlib.sha256(_identity_canonical_bytes(value)).hexdigest()


def load_source_identity(path: Path) -> SourceIdentity:
    """Load and validate a capture_source_snapshot_identity.py JSON document.

    The input is the captured v2 document itself.  Its derived hashes are
    checked before the short identity is used, so a hand-edited commit or
    snapshot cannot be stamped as a managed build.
    """

    document = _read_json_object(path, "source identity")
    if document.get("schema") != SOURCE_IDENTITY_SCHEMA:
        raise BuildVersionError(
            f"source identity schema must be {SOURCE_IDENTITY_SCHEMA}"
        )
    commit_value = _require_lower_hex(
        document.get("head_commit_full"), _HEX40, "source identity commit"
    )
    _require_lower_hex(
        document.get("head_tree_sha256"), _HEX64, "source identity tree digest"
    )
    snapshot_value = _require_lower_hex(
        document.get("source_snapshot_sha256"),
        _HEX64,
        "source identity snapshot digest",
    )
    dirty_value = _require_bool(
        document.get("source_snapshot_dirty"), "source identity dirty state"
    )
    if not isinstance(document.get("git_status_porcelain_v1"), list):
        raise BuildVersionError("source identity status must be a JSON array")
    dirty_content = document.get("dirty_path_content")
    if not isinstance(dirty_content, list):
        raise BuildVersionError("source identity dirty content must be a JSON array")
    dirty_content_digest = _require_lower_hex(
        document.get("dirty_content_sha256"),
        _HEX64,
        "source identity dirty content digest",
    )
    expected_dirty_content_digest = _sha256_json(dirty_content)
    if dirty_content_digest != expected_dirty_content_digest:
        raise BuildVersionError(
            "source identity dirty_content_sha256 does not match its payload"
        )
    if dirty_value != bool(document["git_status_porcelain_v1"]):
        raise BuildVersionError(
            "source identity dirty flag does not match its status payload"
        )

    payload = dict(document)
    for derived in (
        "source_snapshot_dirty",
        "dirty_content_sha256",
        "source_snapshot_sha256",
    ):
        payload.pop(derived, None)
    expected_snapshot = _sha256_json(payload)
    if snapshot_value != expected_snapshot:
        raise BuildVersionError(
            "source identity source_snapshot_sha256 does not match its payload"
        )

    return SourceIdentity(
        git_commit=commit_value,
        source_snapshot_sha256=snapshot_value,
        dirty=dirty_value,
    )


def _validated_base_version(value: Any, source: str) -> str:
    if not isinstance(value, str) or _BASE_VERSION.fullmatch(value) is None:
        raise BuildVersionError(
            f"{source} must contain a numeric MAJOR.MINOR.PATCH version"
        )
    return value


def resolve_base_version(repo_root: Path) -> tuple[str, str]:
    """Resolve the base version from the Cargo workspace authority.

    The Fullmag workspace version is mandatory.  Hard-coded Python package
    versions are checked against it; a package using a dynamic version is
    intentionally left to its own provider.
    """

    cargo_path = repo_root / "Cargo.toml"
    if not cargo_path.is_file():
        raise BuildVersionError(
            f"Cargo workspace manifest is required: {cargo_path}"
        )
    try:
        cargo = tomllib.loads(cargo_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise BuildVersionError(f"cannot read Cargo manifest: {cargo_path}") from error
    workspace = cargo.get("workspace")
    package = workspace.get("package") if isinstance(workspace, dict) else None
    if not isinstance(package, dict) or "version" not in package:
        raise BuildVersionError(
            "Cargo.toml must provide [workspace.package].version"
        )
    base_version = _validated_base_version(
        package["version"], "Cargo.toml [workspace.package].version"
    )
    candidates = [
        (base_version, "Cargo.toml:[workspace.package].version")
    ]

    manifest_paths = [repo_root / "pyproject.toml", repo_root / PYTHON_PACKAGE_MANIFEST]
    for pyproject_path in manifest_paths:
        if not pyproject_path.is_file():
            continue
        try:
            pyproject = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
            raise BuildVersionError(f"cannot read pyproject manifest: {pyproject_path}") from error
        project = pyproject.get("project")
        if isinstance(project, dict) and "version" in project:
            candidates.append(
                (
                    _validated_base_version(
                        project["version"],
                        f"{pyproject_path} [project].version",
                    ),
                    f"{pyproject_path.relative_to(repo_root)}:[project].version",
                )
            )

    versions = {version for version, _ in candidates}
    if len(versions) != 1:
        details = ", ".join(f"{source}={version}" for version, source in candidates)
        raise BuildVersionError(f"authoritative version manifests disagree: {details}")
    source = "+".join(source for _, source in candidates)
    return base_version, source


def _build_datetime(
    source_date_epoch: str | int | None,
    now: datetime | None,
) -> datetime:
    """Resolve one UTC timestamp, with reproducible builds taking priority."""

    if source_date_epoch is None:
        source_date_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if source_date_epoch is not None:
        text = str(source_date_epoch)
        if _EPOCH.fullmatch(text) is None:
            raise BuildVersionError("SOURCE_DATE_EPOCH must be a non-negative integer")
        try:
            timestamp = datetime.fromtimestamp(int(text), tz=timezone.utc)
        except (OverflowError, OSError, ValueError) as error:
            raise BuildVersionError("SOURCE_DATE_EPOCH is outside UTC datetime range") from error
    else:
        timestamp = now if now is not None else datetime.now(timezone.utc)
        if timestamp.tzinfo is None:
            raise BuildVersionError("explicit build time must include a timezone")
        timestamp = timestamp.astimezone(timezone.utc)
    # Version identity has one-second precision, matching SOURCE_DATE_EPOCH.
    return timestamp.replace(microsecond=0)


def _parse_base_components(base_version: str) -> tuple[int, int, int]:
    match = _BASE_VERSION.fullmatch(base_version)
    if match is None:
        raise BuildVersionError("base version has invalid numeric components")
    components = tuple(int(item) for item in match.groups())
    if any(component > 65535 for component in components):
        raise BuildVersionError("base version components exceed Windows 16-bit limits")
    return components


def _windows_file_version(base_version: str, timestamp: datetime) -> tuple[list[int], str]:
    """Map the base version and date to four legal Windows numeric segments.

    Windows VERSIONINFO accepts four unsigned 16-bit integers.  The mapping
    retains the complete numeric base version and uses the number of UTC days
    since 2000-01-01 as the fourth segment.  The supported reproducible build
    range is therefore 2000-01-01 through 2179-06-06.
    """

    major, minor, patch = _parse_base_components(base_version)
    days_since_epoch = (timestamp.date() - WINDOWS_VERSION_EPOCH).days
    segments = [major, minor, patch, days_since_epoch]
    if any(segment < 0 or segment > 65535 for segment in segments):
        raise BuildVersionError(
            "Windows file version requires base components and days since "
            "2000-01-01 to fit unsigned 16-bit segments"
        )
    return segments, ".".join(str(segment) for segment in segments)


def build_version_record(
    repo_root: Path,
    source_identity_path: Path,
    *,
    source_date_epoch: str | int | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build a normalized, serializable version record without writing files."""

    repo_root = repo_root.resolve()
    if not repo_root.is_dir():
        raise BuildVersionError(f"repository root is not a directory: {repo_root}")
    base_version, base_version_source = resolve_base_version(repo_root)
    identity = load_source_identity(source_identity_path)
    timestamp = _build_datetime(source_date_epoch, now)
    windows_segments, windows_version = _windows_file_version(base_version, timestamp)
    date_token = timestamp.strftime("%Y%m%d")
    short_commit = identity.git_short_commit
    snapshot_short = identity.source_snapshot_short

    days_since_2000 = windows_segments[3]
    semver = f"{base_version}-dev.{date_token}.g{short_commit}+{days_since_2000}"
    pep440 = f"{base_version}.dev{date_token}+g{short_commit}"
    if identity.dirty:
        # The snapshot suffix makes two dirty source captures with the same
        # HEAD and date distinguishable without pretending the tree is clean.
        dirty_metadata = f"dirty.s{snapshot_short}"
        semver = f"{base_version}-dev.{date_token}.g{short_commit}.{dirty_metadata}+{days_since_2000}"
        pep440 = f"{pep440}.{dirty_metadata}"

    return {
        "schema": SCHEMA,
        "product": "fullmag",
        "base_version": base_version,
        "base_version_source": base_version_source,
        "development": True,
        "version": semver,
        "product_version": semver,
        "semver_version": semver,
        "pep440_version": pep440,
        "build_date": timestamp.strftime("%Y-%m-%d"),
        "build_date_utc": timestamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "git_commit": identity.git_commit,
        "git_short_commit": short_commit,
        "source_snapshot_sha256": identity.source_snapshot_sha256,
        "source_snapshot_short": snapshot_short,
        "dirty": identity.dirty,
        "worktree_state": identity.worktree_state,
        "windows_file_version": windows_version,
        "windows_file_version_segments": windows_segments,
    }


def canonical_json_bytes(record: Mapping[str, Any]) -> bytes:
    """Return the exact stable JSON representation used by the CLI."""

    return (
        json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True)
        + "\n"
    ).encode("utf-8")


def write_version_record(record: Mapping[str, Any], output: Path) -> None:
    """Atomically write only the explicitly selected canonical output file."""

    output = output.absolute()
    payload = canonical_json_bytes(record)
    temporary_path: Path | None = None
    try:
        absolute_parent = output.parent.absolute()
        canonical_parent = output.parent.resolve(strict=False)
        if os.path.normcase(str(canonical_parent)) != os.path.normcase(
            str(absolute_parent)
        ):
            raise BuildVersionError(f"version output parent is not canonical: {output.parent}")
        output.parent.mkdir(parents=True, exist_ok=True)
        canonical_parent = output.parent.resolve()
        if os.path.normcase(str(canonical_parent)) != os.path.normcase(
            str(absolute_parent)
        ):
            raise BuildVersionError(f"version output parent changed: {output.parent}")
        if os.path.lexists(output):
            if output.is_symlink() or output.is_dir() or not output.is_file():
                raise BuildVersionError(
                    f"version output must be a regular non-symlink file: {output}"
                )
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{output.name}.", suffix=".tmp", dir=str(output.parent)
        )
        temporary_path = Path(temporary_name)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, output)
        temporary_path = None
        try:
            directory_descriptor = os.open(
                output.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
            )
        except OSError:
            directory_descriptor = None
        if directory_descriptor is not None:
            try:
                try:
                    os.fsync(directory_descriptor)
                except OSError:
                    # Windows has no portable directory fsync primitive.  The
                    # file was already flushed before os.replace; keep that
                    # successful publication while retaining POSIX errors.
                    if os.name != "nt":
                        raise
            finally:
                os.close(directory_descriptor)
    except OSError as error:
        raise BuildVersionError(f"cannot write version output: {output}") from error
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--source-identity", type=Path, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="the one canonical JSON file to write",
    )
    parser.add_argument(
        "--source-date-epoch",
        help="optional explicit reproducible timestamp; otherwise SOURCE_DATE_EPOCH is used",
    )
    arguments = parser.parse_args(argv)
    try:
        record = build_version_record(
            arguments.repo_root,
            arguments.source_identity,
            source_date_epoch=arguments.source_date_epoch,
        )
        write_version_record(record, arguments.output)
    except BuildVersionError as error:
        print(f"BUILD_VERSION_ERROR={error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
