"""Resolve the managed Fullmag Python package version without source rewrites.

``setup.py`` calls :func:`get_version` while the package keeps the standard
``setuptools.build_meta`` backend.  The provider validates the canonical
managed JSON record, or performs the explicitly supported source-checkout or
source-archive route.  No tracked source file is rewritten during a build.

Builds should provide ``FULLMAG_BUILD_VERSION_FILE`` with the canonical JSON
record produced by ``scripts/build_version.py``.  A bound source identity may
instead be provided through ``FULLMAG_SOURCE_IDENTITY_FILE``; the backend then
invokes the central generator against that identity and never asks Git for a
new commit.  An unbound Git checkout may capture its current source identity.
An archive without Git requires the explicit
``FULLMAG_ALLOW_UNQUALIFIED_VERSION=1`` opt-in and receives only its numeric
base version, marked as unbound in the resolver result.  A dynamic
``[project]`` version in an archive may additionally provide
``FULLMAG_BASE_VERSION`` when no Cargo workspace is shipped with the archive.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any, Mapping, Sequence


SCHEMA = "fullmag.build-version.v1"
WINDOWS_VERSION_EPOCH = date(2000, 1, 1)
VERSION_FILE_ENV = "FULLMAG_BUILD_VERSION_FILE"
SOURCE_IDENTITY_FILE_ENV = "FULLMAG_SOURCE_IDENTITY_FILE"
ALLOW_UNQUALIFIED_ENV = "FULLMAG_ALLOW_UNQUALIFIED_VERSION"
_BASE_VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
_PEP440_VERSION = re.compile(
    r"(?P<base>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))"
    r"\.dev(?P<date>[0-9]{8})\+g(?P<commit>[0-9a-f]{12})"
    r"(?P<dirty>\.dirty\.s[0-9a-f]{12})?"
)
_SEMVER_VERSION = re.compile(
    r"(?P<base>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))"
    r"-dev\.(?P<date>[0-9]{8})\.g(?P<commit>[0-9a-f]{12})"
    r"(?P<dirty>\.dirty\.s[0-9a-f]{12})?"
    r"\+(?P<days>[0-9]+)"
)
_HEX40 = re.compile(r"[0-9a-f]{40}")
_HEX64 = re.compile(r"[0-9a-f]{64}")


class BuildBackendError(RuntimeError):
    """Raised when package version provenance is missing or inconsistent."""


@dataclass(frozen=True)
class VersionResolution:
    """Resolved package version and its source-binding boundary."""

    pep440_version: str
    base_version: str
    version_source_bound: bool
    reason: str
    record: Mapping[str, Any] | None = None


def _read_json(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BuildBackendError(f"cannot read version record: {path}") from error
    if not isinstance(value, dict):
        raise BuildBackendError("version record must be a JSON object")
    return value


def _require_bool(value: Any, label: str) -> bool:
    if type(value) is not bool:
        raise BuildBackendError(f"{label} must be boolean")
    return value


def _require_hex(value: Any, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise BuildBackendError(f"{label} must be lowercase hexadecimal")
    return value


def _base_version_from_project(project_root: Path) -> str | None:
    """Read the static [project] version without a Python 3.11-only TOML import.

    The package supports Python 3.10, where ``tomllib`` is not in the standard
    library.  This narrow parser intentionally accepts only the scalar version
    field required by this backend; setuptools remains responsible for parsing
    the complete TOML document.
    """

    path = project_root / "pyproject.toml"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise BuildBackendError(f"cannot read package pyproject.toml: {path}") from error

    in_project = False
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        table = re.fullmatch(r"\[([^\]]+)\]", line)
        if table is not None:
            in_project = table.group(1).strip() == "project"
            continue
        if not in_project:
            continue
        match = re.fullmatch(r"version\s*=\s*(['\"])([^'\"]+)\1\s*(?:#.*)?", line)
        if match is not None:
            version = match.group(2)
            if _BASE_VERSION.fullmatch(version) is None:
                raise BuildBackendError(
                    "package [project].version must be numeric MAJOR.MINOR.PATCH"
                )
            return version
    # A future source checkout may use ``dynamic = ["version"]`` and obtain
    # its base from the Cargo workspace or the managed version record.
    return None


def _base_from_package_version(value: str) -> str:
    if _BASE_VERSION.fullmatch(value) is not None:
        return value
    match = _PEP440_VERSION.fullmatch(value)
    if match is not None:
        return match.group("base")
    raise BuildBackendError("package metadata has an unsupported Version value")


def _read_verified_pkg_info_version(project_root: Path) -> str | None:
    """Read a package metadata Version only when its identity is verifiable."""

    candidates = [
        project_root / "PKG-INFO",
        *sorted(project_root.glob("*.egg-info/PKG-INFO")),
        *sorted(project_root.glob("*.dist-info/METADATA")),
    ]
    versions: list[str] = []
    for path in candidates:
        if not path.exists():
            continue
        if path.is_symlink() or not path.is_file():
            raise BuildBackendError(f"package metadata must be a regular file: {path}")
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError) as error:
            raise BuildBackendError(f"cannot read package metadata: {path}") from error
        headers: dict[str, str] = {}
        for line in lines:
            if not line:
                break
            key, separator, value = line.partition(":")
            if separator and key in {"Name", "Version"}:
                if key in headers and headers[key] != value.strip():
                    raise BuildBackendError(f"package metadata repeats {key}: {path}")
                headers[key] = value.strip()
        if headers.get("Name") != "fullmag":
            # A stale setuptools artifact such as UNKNOWN.egg-info is not
            # package metadata and must not block the managed Git route.
            continue
        if "Version" not in headers:
            raise BuildBackendError(f"package metadata identity is incomplete: {path}")
        version = headers["Version"]
        _base_from_package_version(version)
        versions.append(version)
    if not versions:
        return None
    if len(set(versions)) != 1:
        raise BuildBackendError("package metadata Version values disagree")
    return versions[0]


def _validate_version_record(
    record: Mapping[str, Any],
    expected_base_version: str,
) -> str:
    if record.get("schema") != SCHEMA:
        raise BuildBackendError(f"version record schema must be {SCHEMA}")
    base = record.get("base_version")
    if not isinstance(base, str) or _BASE_VERSION.fullmatch(base) is None:
        raise BuildBackendError("version record has an invalid base_version")
    if base != expected_base_version:
        raise BuildBackendError(
            f"version record base_version {base!r} does not match package {expected_base_version!r}"
        )
    if record.get("development") is not True:
        raise BuildBackendError("version record must be a development record")

    commit = _require_hex(record.get("git_commit"), _HEX40, "version record git_commit")
    snapshot = _require_hex(
        record.get("source_snapshot_sha256"), _HEX64, "version record source snapshot"
    )
    dirty = _require_bool(record.get("dirty"), "version record dirty")
    if record.get("worktree_state") != ("dirty" if dirty else "clean"):
        raise BuildBackendError("version record worktree_state disagrees with dirty")
    if record.get("git_short_commit") != commit[:12]:
        raise BuildBackendError("version record git_short_commit is inconsistent")
    if record.get("source_snapshot_short") != snapshot[:12]:
        raise BuildBackendError("version record source_snapshot_short is inconsistent")

    build_date = record.get("build_date")
    if not isinstance(build_date, str):
        raise BuildBackendError("version record build_date is missing")
    try:
        date = datetime.strptime(build_date, "%Y-%m-%d")
    except ValueError as error:
        raise BuildBackendError("version record build_date is invalid") from error
    date_token = date.strftime("%Y%m%d")
    base_components = [int(component) for component in base.split(".")]
    expected_days_since_2000 = (date.date() - WINDOWS_VERSION_EPOCH).days
    segments = record.get("windows_file_version_segments")
    if (
        not isinstance(segments, list)
        or len(segments) != 4
        or any(type(segment) is not int or segment < 0 or segment > 65535 for segment in segments)
        or segments[:3] != base_components
        or segments[3] != expected_days_since_2000
    ):
        raise BuildBackendError("version record Windows numeric version is inconsistent")
    expected_windows_version = ".".join(str(segment) for segment in segments)
    if record.get("windows_file_version") != expected_windows_version:
        raise BuildBackendError("version record Windows version string is inconsistent")
    expected_pep440 = f"{base}.dev{date_token}+g{commit[:12]}"
    expected_semver = f"{base}-dev.{date_token}.g{commit[:12]}"
    if dirty:
        expected_pep440 += f".dirty.s{snapshot[:12]}"
        expected_semver += f".dirty.s{snapshot[:12]}"
    expected_semver += f"+{expected_days_since_2000}"
    if record.get("pep440_version") != expected_pep440:
        raise BuildBackendError("version record pep440_version is inconsistent")
    if (
        record.get("version") != expected_semver
        or record.get("semver_version") != expected_semver
        or (
            "product_version" in record
            and record.get("product_version") != expected_semver
        )
    ):
        raise BuildBackendError("version record SemVer is inconsistent")
    pep_match = _PEP440_VERSION.fullmatch(expected_pep440)
    semver_match = _SEMVER_VERSION.fullmatch(expected_semver)
    if pep_match is None or semver_match is None:
        raise BuildBackendError("version record has an invalid development version")
    return expected_pep440


def _find_repo_root(project_root: Path) -> Path | None:
    for candidate in (project_root, *project_root.parents):
        if (
            (candidate / "scripts" / "build_version.py").is_file()
            and (candidate / "scripts" / "capture_source_snapshot_identity.py").is_file()
            and (candidate / "Cargo.toml").is_file()
            and (candidate / ".git").exists()
        ):
            return candidate
    return None


def _find_metadata_root(project_root: Path) -> Path | None:
    """Find a repository ancestor that can provide Cargo authority."""

    for candidate in (project_root, *project_root.parents):
        if (candidate / "Cargo.toml").is_file():
            return candidate
    return None


def _base_version_from_cargo(repo_root: Path) -> str | None:
    path = repo_root / "Cargo.toml"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise BuildBackendError(f"cannot read Cargo.toml: {path}") from error
    in_workspace_package = False
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        table = re.fullmatch(r"\[([^\]]+)\]", line)
        if table is not None:
            in_workspace_package = table.group(1).strip() == "workspace.package"
            continue
        if not in_workspace_package:
            continue
        match = re.fullmatch(r"version\s*=\s*(['\"])([^'\"]+)\1\s*(?:#.*)?", line)
        if match is not None:
            version = match.group(2)
            if _BASE_VERSION.fullmatch(version) is None:
                raise BuildBackendError(
                    "Cargo [workspace.package].version must be numeric MAJOR.MINOR.PATCH"
                )
            return version
    return None


def _resolve_expected_base_version(
    project_root: Path,
    metadata_root: Path | None,
    record: Mapping[str, Any] | None,
    package_metadata_version: str | None,
) -> str:
    project_base = _base_version_from_project(project_root)
    cargo_base = (
        _base_version_from_cargo(metadata_root) if metadata_root is not None else None
    )
    metadata_base = (
        _base_from_package_version(package_metadata_version)
        if package_metadata_version is not None
        else None
    )
    candidates = [
        ("package", project_base),
        ("Cargo workspace", cargo_base),
        ("PKG-INFO", metadata_base),
    ]
    observed = {value for _, value in candidates if value is not None}
    if len(observed) > 1:
        details = ", ".join(f"{label}={value}" for label, value in candidates if value)
        raise BuildBackendError(
            f"authoritative package versions disagree: {details}"
        )
    if cargo_base is not None:
        return cargo_base
    if project_base is not None:
        return project_base
    if metadata_base is not None:
        return metadata_base
    configured = os.environ.get("FULLMAG_BASE_VERSION")
    if configured is not None:
        if _BASE_VERSION.fullmatch(configured) is None:
            raise BuildBackendError("FULLMAG_BASE_VERSION is not numeric MAJOR.MINOR.PATCH")
        return configured
    if record is not None:
        candidate = record.get("base_version")
        if isinstance(candidate, str) and _BASE_VERSION.fullmatch(candidate) is not None:
            return candidate
    raise BuildBackendError(
        "no authoritative base version found in package pyproject.toml or Cargo workspace"
    )


def _run_checked(command: Sequence[str], *, label: str) -> None:
    try:
        result = subprocess.run(
            list(command),
            cwd=None,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BuildBackendError(f"{label} failed to start or timed out") from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        if len(detail) > 2000:
            detail = detail[:2000] + "..."
        raise BuildBackendError(f"{label} failed: {detail}")


def _generate_from_identity(
    repo_root: Path,
    identity_path: Path,
    expected_base_version: str,
) -> VersionResolution:
    generator = repo_root / "scripts" / "build_version.py"
    with tempfile.TemporaryDirectory(prefix="fullmag-build-version-") as temporary:
        output = Path(temporary) / "version.json"
        _run_checked(
            [
                sys.executable,
                str(generator),
                "--repo-root",
                str(repo_root),
                "--source-identity",
                str(identity_path),
                "--output",
                str(output),
            ],
            label="central version generator",
        )
        record = _read_json(output)
    pep440 = _validate_version_record(record, expected_base_version)
    return VersionResolution(
        pep440_version=pep440,
        base_version=expected_base_version,
        version_source_bound=True,
        reason="managed-source-identity",
        record=record,
    )


def _capture_current_source(
    repo_root: Path,
    expected_base_version: str,
) -> VersionResolution:
    capture = repo_root / "scripts" / "capture_source_snapshot_identity.py"
    with tempfile.TemporaryDirectory(prefix="fullmag-source-identity-") as temporary:
        identity = Path(temporary) / "source-identity.json"
        _run_checked(
            [
                sys.executable,
                str(capture),
                "--repo-root",
                str(repo_root),
                "--output",
                str(identity),
            ],
            label="source identity capture",
        )
        return _generate_from_identity(repo_root, identity, expected_base_version)


def _allow_unqualified_archive() -> bool:
    return os.environ.get(ALLOW_UNQUALIFIED_ENV) == "1"


def _configured_path(project_root: Path, value: str) -> Path:
    candidate = Path(value).expanduser()
    if not candidate.is_absolute():
        candidate = project_root / candidate
    return candidate


def resolve_version(project_root: Path) -> VersionResolution:
    """Resolve a package version without mutating the source checkout."""

    project_root = project_root.resolve()
    version_file = os.environ.get(VERSION_FILE_ENV)
    identity_file = os.environ.get(SOURCE_IDENTITY_FILE_ENV)
    configured_record: Mapping[str, Any] | None = None
    if version_file is not None:
        if not version_file:
            raise BuildBackendError(f"{VERSION_FILE_ENV} cannot be empty")
        configured_record = _read_json(_configured_path(project_root, version_file))

    repo_root = _find_repo_root(project_root)
    metadata_root = _find_metadata_root(project_root)
    package_metadata_version = (
        _read_verified_pkg_info_version(project_root)
        if repo_root is None and version_file is None and identity_file is None
        else None
    )
    expected_base = _resolve_expected_base_version(
        project_root,
        metadata_root,
        configured_record,
        package_metadata_version,
    )
    if version_file is not None:
        pep440 = _validate_version_record(configured_record or {}, expected_base)
        return VersionResolution(
            pep440_version=pep440,
            base_version=expected_base,
            version_source_bound=True,
            reason="managed-version-file",
            record=configured_record,
        )

    if identity_file is not None:
        if not identity_file:
            raise BuildBackendError(f"{SOURCE_IDENTITY_FILE_ENV} cannot be empty")
        if repo_root is None:
            raise BuildBackendError(
                f"{SOURCE_IDENTITY_FILE_ENV} requires the central repository scripts"
            )
        return _generate_from_identity(
            repo_root,
            _configured_path(project_root, identity_file),
            expected_base,
        )

    if repo_root is not None:
        # This route is intentionally limited to an actual checkout. Managed
        # builds must provide a version file or bound identity so an older
        # source snapshot is never replaced by a fresh HEAD capture.
        return _capture_current_source(repo_root, expected_base)

    if package_metadata_version is not None:
        return VersionResolution(
            pep440_version=package_metadata_version,
            base_version=expected_base,
            version_source_bound=False,
            reason="source-archive-pkg-info",
            record=None,
        )

    if not _allow_unqualified_archive():
        raise BuildBackendError(
            "package source has no Git identity; set "
            f"{ALLOW_UNQUALIFIED_ENV}=1 to allow an explicitly unqualified archive build"
        )
    return VersionResolution(
        pep440_version=expected_base,
        base_version=expected_base,
        version_source_bound=False,
        reason="source-archive-without-git",
        record=None,
    )


def get_version(project_root: Path | None = None) -> str:
    """Return the PEP 440 version selected for a package build.

    This is the small provider surface used by ``setup.py`` while the package
    keeps the standard ``setuptools.build_meta`` backend.
    """

    return resolve_version(project_root or Path.cwd()).pep440_version
