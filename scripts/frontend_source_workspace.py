"""Stage current Control Room sources with read-only native dependencies.

The native Windows launcher keeps an installed frontend workspace below its
managed build root. This module validates that workspace against the current
checkout, then stages fresh source copies for checks and links only the two
validated ``node_modules`` directories into that new stage. It never installs
packages, copies dependencies, or edits the native workspace.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from typing import Any


SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

import fullmag_storage
from windows import build_snapshot, stage_workspace_frontend


SCHEMA = "fullmag.native-workspace-frontend-source.v1"
SOURCE_CHECK_PROFILE = "windows-control-room-source-check"
MANIFEST_NAME = "frontend-source-manifest.json"
ROOT_DEPENDENCY_INPUTS = (
    Path("package.json"),
    Path("pnpm-lock.yaml"),
    Path("pnpm-workspace.yaml"),
)
CONTROL_ROOM_PACKAGE = Path("apps") / "control-room" / "package.json"
OPTIONAL_DEPENDENCY_INPUTS = (Path(".npmrc"),)
STAGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
REPARSE_POINT_ATTRIBUTE = 0x400


class SourceWorkspaceError(ValueError):
    """Raised when a dependency workspace does not satisfy the source contract."""


def _path_key(path: str | os.PathLike[str]) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(os.fspath(path))))


def _same_path(left: str | os.PathLike[str], right: str | os.PathLike[str]) -> bool:
    return _path_key(left) == _path_key(right)


def _is_reparse_point(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    return path.is_symlink() or bool(
        getattr(metadata, "st_file_attributes", 0) & REPARSE_POINT_ATTRIBUTE
    )


def _validated_directory(path: Path, root: Path, label: str) -> Path:
    try:
        resolved = fullmag_storage.validate_path(path, root, label)
    except (OSError, RuntimeError, fullmag_storage.StorageError) as error:
        raise SourceWorkspaceError(str(error)) from error
    try:
        metadata = resolved.lstat()
    except OSError as error:
        raise SourceWorkspaceError(f"{label} is missing or cannot be inspected: {path}") from error
    if _is_reparse_point(resolved) or not stat.S_ISDIR(metadata.st_mode):
        raise SourceWorkspaceError(f"{label} must be a regular directory: {path}")
    return resolved


def _validated_regular_file(path: Path, root: Path, label: str) -> Path:
    try:
        resolved = fullmag_storage.validate_path(path, root, label)
    except (OSError, RuntimeError, fullmag_storage.StorageError) as error:
        raise SourceWorkspaceError(str(error)) from error
    try:
        metadata = resolved.lstat()
    except OSError as error:
        raise SourceWorkspaceError(f"{label} is missing or cannot be inspected: {path}") from error
    if _is_reparse_point(resolved) or not stat.S_ISREG(metadata.st_mode):
        raise SourceWorkspaceError(f"{label} must be a regular file: {path}")
    return resolved


def _read_regular_file(path: Path, root: Path, label: str) -> bytes:
    resolved = _validated_regular_file(path, root, label)
    try:
        return resolved.read_bytes()
    except OSError as error:
        raise SourceWorkspaceError(f"Cannot read {label}: {path}") from error


def _validate_repo_root(repo: Path) -> Path:
    if not isinstance(repo, Path):
        repo = Path(repo)
    if not repo.is_absolute():
        raise SourceWorkspaceError(f"Repository path must be absolute: {repo}")
    repo_root = _validated_directory(repo, repo, "repository root")
    try:
        git_root = Path(fullmag_storage.git(repo_root, "rev-parse", "--show-toplevel")).resolve(strict=True)
    except (OSError, RuntimeError, fullmag_storage.StorageError) as error:
        raise SourceWorkspaceError(f"Cannot identify repository root: {repo_root}") from error
    if not _same_path(repo_root, git_root):
        raise SourceWorkspaceError(
            f"Repository argument must name the Git checkout root: {repo_root} != {git_root}"
        )
    return repo_root


def _resolve_profiles(
    repo: Path, layout: dict[str, Any]
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    if not isinstance(layout, dict):
        raise SourceWorkspaceError("Resolved storage layout must be a mapping")
    fixed_profiles = tuple(fullmag_storage.WINDOWS_WORKSPACE_STORAGE_PROFILES.values())
    selected_profile = layout.get("profile")
    if selected_profile not in {*fixed_profiles, SOURCE_CHECK_PROFILE}:
        raise SourceWorkspaceError(
            "Layout must use a fixed native Windows workspace profile or the source-check profile"
        )

    try:
        selected_layout = fullmag_storage.resolve_layout(repo, profile=selected_profile)
    except (OSError, RuntimeError, fullmag_storage.StorageError) as error:
        raise SourceWorkspaceError(
            f"Cannot resolve selected storage profile {selected_profile}: {error}"
        ) from error

    path_fields = (
        "repo_root",
        "project_root",
        "storage_root",
        "build_root",
        "runs_root",
    )
    for field in path_fields:
        actual = layout.get(field)
        expected = selected_layout.get(field)
        if not isinstance(actual, str) or not isinstance(expected, str) or not _same_path(actual, expected):
            raise SourceWorkspaceError(f"Layout field {field!r} does not match the resolved profile")
    if layout.get("worktree_id") != selected_layout.get("worktree_id"):
        raise SourceWorkspaceError("Layout worktree identity does not match the requested checkout")

    candidates: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for profile in fixed_profiles:
        if profile == selected_profile:
            candidates[profile] = selected_layout
            continue
        try:
            candidate = fullmag_storage.resolve_layout(repo, profile=profile)
        except (OSError, RuntimeError, fullmag_storage.StorageError) as error:
            errors.append(f"{profile}: {error}")
            continue
        candidates[profile] = candidate

    if not candidates:
        detail = "; ".join(errors)
        raise SourceWorkspaceError(f"Cannot resolve a native workspace profile: {detail}")
    return candidates, selected_layout


def _check_manifest_path(
    manifest: dict[str, Any],
    field: str,
    expected: Path,
    containment_root: Path,
) -> None:
    raw = manifest.get(field)
    if not isinstance(raw, str) or not Path(raw).is_absolute():
        raise SourceWorkspaceError(f"Source manifest field {field!r} must be an absolute path")
    try:
        resolved = fullmag_storage.validate_path(raw, containment_root, f"source manifest {field}")
    except (OSError, RuntimeError, fullmag_storage.StorageError) as error:
        raise SourceWorkspaceError(str(error)) from error
    if not _same_path(resolved, expected):
        raise SourceWorkspaceError(
            f"Source manifest field {field!r} does not match its expected workspace path"
        )


def _check_manifest_source_root(
    manifest: dict[str, Any],
    repo: Path,
    build_root: Path,
    expected_worktree_id: str,
) -> None:
    if "build_source_snapshot" not in manifest:
        _check_manifest_path(manifest, "source_root", repo, repo)
        return

    binding = manifest.get("build_source_snapshot")
    binding_fields = {"record_path", "inventory_sha256", "source_root"}
    if not isinstance(binding, dict) or set(binding) != binding_fields:
        raise SourceWorkspaceError("Frozen source binding must contain exactly record_path, inventory_sha256, and source_root")
    record_path_value = binding.get("record_path")
    inventory_sha256 = binding.get("inventory_sha256")
    source_root_value = binding.get("source_root")
    if (
        not isinstance(record_path_value, str)
        or not Path(record_path_value).is_absolute()
        or not isinstance(inventory_sha256, str)
        or not re.fullmatch(r"[0-9a-f]{64}", inventory_sha256)
        or not isinstance(source_root_value, str)
        or not Path(source_root_value).is_absolute()
    ):
        raise SourceWorkspaceError("Frozen source binding contains an invalid path or inventory digest")

    record_path = _validated_regular_file(
        Path(record_path_value), build_root, "frozen source snapshot record"
    )
    try:
        verified = build_snapshot.verify_snapshot(record_path, build_root)
    except (OSError, ValueError, build_snapshot.SnapshotError, fullmag_storage.StorageError) as error:
        raise SourceWorkspaceError(f"Frozen source snapshot failed verification: {error}") from error

    if (
        record_path_value != verified.get("record_path")
        or inventory_sha256 != verified.get("inventory_sha256")
        or source_root_value != verified.get("source_root")
    ):
        raise SourceWorkspaceError("Frozen source binding differs from the verified snapshot record")

    origin_repo_root = verified.get("origin_repo_root")
    if not isinstance(origin_repo_root, str) or not _same_path(origin_repo_root, repo):
        raise SourceWorkspaceError("Frozen source snapshot belongs to another repository checkout")
    if verified.get("origin_worktree_id") != expected_worktree_id:
        raise SourceWorkspaceError("Frozen source snapshot belongs to another registered worktree")

    verified_source_root = _validated_directory(
        Path(source_root_value), build_root, "verified frozen frontend source root"
    )
    _check_manifest_path(manifest, "source_root", verified_source_root, build_root)


def _read_dependency_manifest(
    repo: Path,
    build_root: Path,
    dependency_workspace: Path,
    expected_worktree_id: str,
) -> tuple[dict[str, Any], Path, Path, Path, str]:
    workspace = _validated_directory(dependency_workspace, build_root, "native dependency workspace")
    if workspace.name != "workspace":
        raise SourceWorkspaceError("Native dependency workspace must be the explicit workspace directory")
    stage_root = workspace.parent
    sources_root = build_root / "frontend-sources"
    try:
        validated_stage_root = fullmag_storage.validate_path(
            stage_root, build_root, "native dependency stage root"
        )
    except (OSError, RuntimeError, fullmag_storage.StorageError) as error:
        raise SourceWorkspaceError(str(error)) from error
    if not _same_path(validated_stage_root.parent, sources_root):
        raise SourceWorkspaceError(
            "Native dependency workspace must be directly under build_root/frontend-sources/<stage_id>"
        )
    stage_id = validated_stage_root.name
    if not STAGE_ID_RE.fullmatch(stage_id):
        raise SourceWorkspaceError(f"Native dependency stage id is invalid: {stage_id!r}")
    expected_stage_root = sources_root / stage_id
    expected_workspace = expected_stage_root / "workspace"
    if not _same_path(workspace, expected_workspace):
        raise SourceWorkspaceError("Native dependency workspace path does not match its stage identity")

    manifest_path = expected_stage_root / MANIFEST_NAME
    manifest_bytes = _read_regular_file(manifest_path, build_root, "native frontend source manifest")
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SourceWorkspaceError(f"Native frontend source manifest is not valid UTF-8 JSON: {manifest_path}") from error
    if not isinstance(manifest, dict):
        raise SourceWorkspaceError("Native frontend source manifest must contain a JSON object")
    if manifest.get("schema") != SCHEMA:
        raise SourceWorkspaceError("Native frontend source manifest has an unsupported schema")
    if manifest.get("stage_id") != stage_id:
        raise SourceWorkspaceError("Native frontend source manifest stage_id does not match its directory")
    if manifest.get("mode") not in {"dev", "static"}:
        raise SourceWorkspaceError("Native frontend source manifest has an invalid staging mode")

    expected_app = expected_workspace / "apps" / "control-room"
    _check_manifest_source_root(manifest, repo, build_root, expected_worktree_id)
    _check_manifest_path(manifest, "build_root", build_root, build_root)
    _check_manifest_path(manifest, "stage_root", expected_stage_root, build_root)
    _check_manifest_path(manifest, "workspace_root", expected_workspace, build_root)
    _check_manifest_path(manifest, "app_root", expected_app, build_root)

    app_root = _validated_directory(expected_app, expected_workspace, "native Control Room app")
    return (
        manifest,
        manifest_path,
        workspace,
        app_root,
        hashlib.sha256(manifest_bytes).hexdigest(),
    )


def _dependency_input_paths(repo: Path) -> list[Path]:
    paths = [repo / relative for relative in ROOT_DEPENDENCY_INPUTS]
    paths.append(repo / CONTROL_ROOM_PACKAGE)
    lock_importers = stage_workspace_frontend._parse_lock_importers(repo / "pnpm-lock.yaml")
    try:
        app_manifests = stage_workspace_frontend._direct_app_package_manifests(repo, lock_importers)
    except (OSError, ValueError, stage_workspace_frontend.StageError) as error:
        raise SourceWorkspaceError(f"Cannot enumerate workspace app manifests: {error}") from error
    paths.extend(app_manifests)
    paths.extend(repo / relative for relative in OPTIONAL_DEPENDENCY_INPUTS)

    unique: dict[str, Path] = {}
    for path in paths:
        relative = path.relative_to(repo).as_posix()
        unique[relative] = path
    return [unique[key] for key in sorted(unique)]


def _compare_dependency_inputs(repo: Path, workspace: Path) -> dict[str, str | None]:
    hashes: dict[str, str | None] = {}
    for source_path in _dependency_input_paths(repo):
        relative = source_path.relative_to(repo)
        installed_path = workspace / relative
        optional = relative in OPTIONAL_DEPENDENCY_INPUTS
        source_exists = os.path.lexists(source_path)
        installed_exists = os.path.lexists(installed_path)
        if optional and not source_exists and not installed_exists:
            hashes[relative.as_posix()] = None
            continue
        if source_exists != installed_exists:
            raise SourceWorkspaceError(
                f"Dependency input presence differs between checkout and native workspace: {relative.as_posix()}"
            )
        if not source_exists:
            raise SourceWorkspaceError(f"Required dependency input is missing: {relative.as_posix()}")
        source_bytes = _read_regular_file(source_path, repo, f"checkout dependency input {relative.as_posix()}")
        installed_bytes = _read_regular_file(
            installed_path, workspace, f"native dependency input {relative.as_posix()}"
        )
        if source_bytes != installed_bytes:
            raise SourceWorkspaceError(
                f"Dependency input differs from the installed native workspace: {relative.as_posix()}"
            )
        hashes[relative.as_posix()] = hashlib.sha256(installed_bytes).hexdigest()
    return hashes


def _input_hash(hashes: dict[str, str | None]) -> str:
    payload = json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def validate_dependency_workspace(
    repo: Path,
    layout: dict[str, Any],
    dependency_workspace: Path,
) -> dict[str, Any]:
    """Validate one explicit installed workspace without writing to it."""

    try:
        repo_root = _validate_repo_root(Path(repo))
        candidates, run_layout = _resolve_profiles(repo_root, layout)
        requested = Path(dependency_workspace)
        if not requested.is_absolute():
            raise SourceWorkspaceError(f"Dependency workspace path must be absolute: {requested}")

        matching_layout: dict[str, Any] | None = None
        for candidate in candidates.values():
            try:
                expected_build = fullmag_storage.validate_path(
                    candidate["build_root"], candidate["storage_root"], "native workspace build root"
                )
                canonical = fullmag_storage.validate_path(
                    requested, expected_build, "native dependency workspace"
                )
            except (OSError, RuntimeError, fullmag_storage.StorageError):
                continue
            if _same_path(canonical, requested):
                matching_layout = candidate
                break
        if matching_layout is None:
            raise SourceWorkspaceError(
                "Dependency workspace must be the explicit frontend-sources/<stage_id>/workspace "
                "under a build root resolved from a fixed native Windows workspace profile"
            )

        build_root = fullmag_storage.validate_path(
            matching_layout["build_root"],
            matching_layout["storage_root"],
            "native workspace build root",
        )
        manifest, manifest_path, workspace, app_root, manifest_sha256 = _read_dependency_manifest(
            repo_root, build_root, requested, matching_layout["worktree_id"]
        )

        root_modules = _validated_directory(
            workspace / "node_modules", workspace, "native root node_modules"
        )
        app_modules = _validated_directory(
            app_root / "node_modules", workspace, "native app node_modules"
        )
        dependency_hashes = _compare_dependency_inputs(repo_root, workspace)

        return {
            "dependency_workspace": str(workspace),
            "dependency_app": str(app_root),
            "dependency_root_node_modules": str(root_modules),
            "dependency_app_node_modules": str(app_modules),
            "dependency_manifest": str(manifest_path),
            "dependency_manifest_sha256": manifest_sha256,
            "dependency_input_hashes": dependency_hashes,
            "dependency_inputs_sha256": _input_hash(dependency_hashes),
            "dependency_stage_id": manifest["stage_id"],
            "dependency_profile": matching_layout["profile"],
            "source_run_profile": run_layout["profile"],
            "source_run_build_root": str(run_layout["build_root"]),
        }
    except SourceWorkspaceError:
        raise
    except (OSError, RuntimeError, ValueError, TypeError, fullmag_storage.StorageError) as error:
        raise SourceWorkspaceError(str(error)) from error


def prepare_source_workspace(
    repo: Path,
    layout: dict[str, Any],
    run_root: Path,
    dependency_workspace: Path,
) -> dict[str, Any]:
    """Stage current source copies and link validated installed dependencies."""

    repo_root = _validate_repo_root(Path(repo))
    dependency = validate_dependency_workspace(repo_root, layout, Path(dependency_workspace))
    try:
        owned_run_root = fullmag_storage.validate_path(
            run_root,
            dependency["source_run_build_root"],
            "frontend source-check run root",
        )
    except (OSError, RuntimeError, fullmag_storage.StorageError) as error:
        raise SourceWorkspaceError(f"Invalid frontend source-check run root: {run_root}") from error
    owned_run_root = _validated_directory(
        owned_run_root,
        Path(dependency["source_run_build_root"]),
        "frontend source-check run root",
    )

    try:
        staged = stage_workspace_frontend.stage_workspace_frontend(
            repo_root,
            owned_run_root,
            mode="dev",
            web_port=3197,
        )
    except (OSError, RuntimeError, ValueError, stage_workspace_frontend.StageError) as error:
        # The stage helper intentionally leaves partial evidence in place.
        raise SourceWorkspaceError(f"Could not stage current frontend sources: {error}") from error

    workspace_root = _validated_directory(
        Path(staged["workspace_root"]), owned_run_root, "new staged frontend workspace"
    )
    stage_root = _validated_directory(
        Path(staged["stage_root"]), owned_run_root, "new staged frontend source stage"
    )
    app_root = _validated_directory(
        workspace_root / "apps" / "control-room", workspace_root, "new staged Control Room app"
    )
    source_manifest = _validated_regular_file(
        Path(staged["manifest_path"]), stage_root, "new staged frontend source manifest"
    )

    try:
        stage_workspace_frontend._make_directory_link(
            workspace_root / "node_modules", Path(dependency["dependency_root_node_modules"])
        )
        stage_workspace_frontend._make_directory_link(
            app_root / "node_modules", Path(dependency["dependency_app_node_modules"])
        )
    except (OSError, RuntimeError, ValueError, stage_workspace_frontend.StageError) as error:
        # Keep the generated source stage and any successfully-created link for inspection.
        raise SourceWorkspaceError(f"Could not link validated native dependencies: {error}") from error

    return {
        "app": app_root,
        "dependencies": app_root / "node_modules",
        "workspace_root": workspace_root,
        "dependency_mode": "native_workspace_read_only",
        "dependency_manifest": dependency["dependency_manifest"],
        "dependency_manifest_sha256": dependency["dependency_manifest_sha256"],
        "dependency_input_hashes": dependency["dependency_input_hashes"],
        "dependency_inputs_sha256": dependency["dependency_inputs_sha256"],
        "dependency_workspace": dependency["dependency_workspace"],
        "dependency_root_node_modules": dependency["dependency_root_node_modules"],
        "dependency_app_node_modules": dependency["dependency_app_node_modules"],
        "dependency_profile": dependency["dependency_profile"],
        "source_run_profile": dependency["source_run_profile"],
        "source_run_build_root": dependency["source_run_build_root"],
        "source_manifest": str(source_manifest),
        "source_manifest_sha256": staged["manifest_sha256"],
        "source_stage_id": staged["stage_id"],
    }
