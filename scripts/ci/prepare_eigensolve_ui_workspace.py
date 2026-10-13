"""Stage only pnpm workspace manifests into the resolved CI frontend root."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


class WorkspacePreparationError(RuntimeError):
    pass


WORKSPACE_DEPENDENCY_SECTIONS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)


def _inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _canonical_directory(value: str, label: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute() or ".." in candidate.parts:
        raise WorkspacePreparationError(f"{label} must be an absolute normalized path")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise WorkspacePreparationError(f"{label} does not exist: {candidate}") from error
    lexical = Path(os.path.abspath(candidate))
    if os.path.normcase(str(lexical)) != os.path.normcase(str(resolved)):
        raise WorkspacePreparationError(f"{label} must not traverse a symlink: {candidate}")
    if not resolved.is_dir():
        raise WorkspacePreparationError(f"{label} is not a directory: {resolved}")
    return resolved


def _source_file(path: Path, repo: Path) -> tuple[str, bytes]:
    if path.is_symlink() or not path.is_file():
        raise WorkspacePreparationError(f"Workspace manifest must be a regular source file: {path}")
    try:
        relative = path.relative_to(repo).as_posix()
        content = path.read_bytes()
    except (OSError, ValueError) as error:
        raise WorkspacePreparationError(f"Cannot read workspace manifest: {path}") from error
    return relative, content


def _workspace_packages(workspace_bytes: bytes) -> tuple[str, ...]:
    try:
        text = workspace_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise WorkspacePreparationError("pnpm-workspace.yaml is not UTF-8") from error

    found_packages = False
    inside_packages = False
    patterns: list[str] = []
    for raw_line in text.splitlines():
        if inside_packages and raw_line and not raw_line[0].isspace():
            inside_packages = False

        if not inside_packages:
            if raw_line.startswith("packages:"):
                if raw_line.strip() != "packages:" or found_packages:
                    raise WorkspacePreparationError(
                        "pnpm workspace package metadata must use one simple packages list"
                    )
                found_packages = True
                inside_packages = True
            continue

        line = re.split(r"\s+#", raw_line.strip(), maxsplit=1)[0].strip()
        if not line:
            continue
        if not line.startswith("-"):
            raise WorkspacePreparationError(
                "Unsupported pnpm workspace package metadata; expected a list of package globs"
            )
        pattern = line[1:].strip()
        if len(pattern) >= 2 and pattern[0] == pattern[-1] and pattern[0] in ("'", '"'):
            pattern = pattern[1:-1]
        if pattern != "apps/*":
            raise WorkspacePreparationError(
                f"Unsupported pnpm workspace package glob outside apps/*: {pattern!r}"
            )
        patterns.append(pattern)

    if not found_packages or patterns != ["apps/*"]:
        raise WorkspacePreparationError(
            "pnpm workspace metadata must declare exactly the supported apps/* package glob"
        )
    return tuple(patterns)


def _check_workspace_dependencies(manifests: list[tuple[str, bytes]]) -> None:
    app_names: set[str] = set()
    parsed_manifests: list[tuple[str, dict]] = []
    for relative, content in manifests:
        if Path(relative).name != "package.json":
            continue
        try:
            value = json.loads(content)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise WorkspacePreparationError(f"Invalid JSON workspace manifest: {relative}") from error
        if not isinstance(value, dict):
            raise WorkspacePreparationError(f"Workspace manifest must contain a JSON object: {relative}")
        parsed_manifests.append((relative, value))
        if relative.startswith("apps/"):
            name = value.get("name")
            if not isinstance(name, str) or not name:
                raise WorkspacePreparationError(f"Workspace package has no package name: {relative}")
            if name in app_names:
                raise WorkspacePreparationError(f"Duplicate workspace package name: {name}")
            app_names.add(name)

    for relative, manifest in parsed_manifests:
        for section in WORKSPACE_DEPENDENCY_SECTIONS:
            dependencies = manifest.get(section, {})
            if not isinstance(dependencies, dict):
                raise WorkspacePreparationError(f"Invalid {section} object in {relative}")
            for package_name, version in dependencies.items():
                if isinstance(version, str) and version.startswith("workspace:"):
                    if package_name not in app_names:
                        raise WorkspacePreparationError(
                            f"Workspace dependency {package_name!r} in {relative} is outside staged apps/* manifests"
                        )


def _manifest_sources(repo: Path) -> list[tuple[str, bytes]]:
    paths = [
        repo / "package.json",
        repo / "pnpm-lock.yaml",
        repo / "pnpm-workspace.yaml",
    ]
    apps_root = repo / "apps"
    if apps_root.is_symlink() or not apps_root.is_dir():
        raise WorkspacePreparationError("apps must be a regular directory in the checkout")
    for app_dir in sorted(apps_root.iterdir(), key=lambda item: item.name):
        if app_dir.is_symlink():
            raise WorkspacePreparationError(f"Workspace app directory must not be a symlink: {app_dir}")
        if not app_dir.is_dir():
            continue
        package_manifest = app_dir / "package.json"
        if package_manifest.exists() or package_manifest.is_symlink():
            paths.append(package_manifest)

    manifests = [_source_file(path, repo) for path in paths]
    _workspace_packages(dict(manifests)["pnpm-workspace.yaml"])
    _check_workspace_dependencies(manifests)
    return manifests


def _destination(frontend_root: Path, build_storage_root: Path, relative: str) -> Path:
    relative_path = Path(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise WorkspacePreparationError(f"Invalid workspace manifest destination: {relative}")
    target = frontend_root / relative_path
    lexical = Path(os.path.abspath(target))
    if not _inside(lexical, frontend_root) or not _inside(lexical, build_storage_root):
        raise WorkspacePreparationError(f"Workspace manifest destination escapes managed storage: {target}")
    return target


def _preflight_destination(root: Path, target: Path) -> None:
    if not _inside(target, root):
        raise WorkspacePreparationError(f"Destination is outside the managed frontend root: {target}")
    relative = target.relative_to(root)
    current = root
    for component in relative.parts[:-1]:
        current = current / component
        if current.is_symlink():
            raise WorkspacePreparationError(f"Manifest destination parent must not be a symlink: {current}")
        if current.exists() and not current.is_dir():
            raise WorkspacePreparationError(f"Manifest destination parent is not a directory: {current}")
    if target.is_symlink():
        raise WorkspacePreparationError(f"Manifest destination must not be a symlink: {target}")
    if target.exists() and not target.is_file():
        raise WorkspacePreparationError(f"Manifest destination is not a regular file: {target}")


def _ensure_parent_directories(root: Path, target: Path) -> None:
    current = root
    for component in target.relative_to(root).parts[:-1]:
        current = current / component
        if current.is_symlink():
            raise WorkspacePreparationError(f"Manifest destination parent must not be a symlink: {current}")
        current.mkdir(exist_ok=True)
        if current.is_symlink() or not current.is_dir():
            raise WorkspacePreparationError(f"Cannot create safe manifest destination parent: {current}")


def _write_exact_bytes(root: Path, target: Path, content: bytes) -> None:
    _ensure_parent_directories(root, target)
    _preflight_destination(root, target)
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if target.is_symlink():
            raise WorkspacePreparationError(f"Manifest destination became a symlink: {target}")
        os.replace(temporary_name, target)
    except OSError as error:
        raise WorkspacePreparationError(f"Cannot stage workspace manifest: {target}") from error


def _resolve_layout(repo: Path) -> dict:
    command = [
        sys.executable,
        str(repo / "scripts" / "fullmag_storage.py"),
        "resolve",
        "--repo-root",
        str(repo),
        "--profile",
        "linux-host",
        "--format",
        "json",
    ]
    result = subprocess.run(command, cwd=repo, capture_output=True, text=True, check=False)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip()
        raise WorkspacePreparationError(f"Storage layout resolution failed: {detail}")
    try:
        layout = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise WorkspacePreparationError("Storage resolver returned invalid JSON") from error
    if not isinstance(layout, dict):
        raise WorkspacePreparationError("Storage resolver returned an invalid layout")
    return layout


def _verify_github_checkout(repo: Path) -> str:
    if os.environ.get("GITHUB_ACTIONS", "").lower() != "true":
        raise WorkspacePreparationError("This workspace preparation helper runs only in GitHub Actions")
    source_sha = os.environ.get("GITHUB_SHA", "").lower()
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", source_sha):
        raise WorkspacePreparationError("GITHUB_SHA must be a full Git commit SHA")
    result = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise WorkspacePreparationError("Cannot verify the checked-out Git commit")
    if result.stdout.strip().lower() != source_sha:
        raise WorkspacePreparationError("Checkout HEAD does not match GITHUB_SHA")
    return source_sha


def _resolved_layout_roots(repo: Path, layout: dict) -> tuple[Path, Path, Path]:
    if layout.get("profile") != "linux-host":
        raise WorkspacePreparationError("Storage resolver did not return the linux-host profile")
    if Path(str(layout.get("repo_root", ""))).resolve() != repo:
        raise WorkspacePreparationError("Storage resolver returned a different checkout")

    storage_root = _canonical_directory(str(layout.get("storage_root", "")), "storage_root")
    build_storage_root = _canonical_directory(
        str(layout.get("build_storage_root", "")), "build_storage_root"
    )
    frontend_root = _canonical_directory(str(layout.get("frontend_root", "")), "frontend_root")
    if not _inside(frontend_root, build_storage_root):
        raise WorkspacePreparationError("Resolved frontend_root is outside build_storage_root")
    if not layout.get("managed_ext4") and not _inside(frontend_root, storage_root):
        raise WorkspacePreparationError("Resolved frontend_root is outside storage_root")
    if layout.get("managed_ext4"):
        native_mount_view = _canonical_directory(
            str(layout.get("native_mount_view", "")), "native_mount_view"
        )
        if build_storage_root != native_mount_view / "storage":
            raise WorkspacePreparationError("Managed build storage does not match the resolved native mount view")

    worktree_id = layout.get("worktree_id")
    if not isinstance(worktree_id, str) or not re.fullmatch(r"[a-z0-9._-]+", worktree_id):
        raise WorkspacePreparationError("Storage resolver returned an invalid worktree id")
    expected_frontend = build_storage_root / "builds" / worktree_id / "frontend"
    if frontend_root != expected_frontend:
        raise WorkspacePreparationError("Resolved frontend_root is not the canonical worktree frontend path")
    return storage_root, build_storage_root, frontend_root


def _append_github_environment(frontend_root: Path, build_storage_root: Path) -> None:
    raw_path = os.environ.get("GITHUB_ENV")
    if not raw_path:
        raise WorkspacePreparationError("GITHUB_ENV is required in GitHub Actions")
    path = Path(raw_path)
    if not path.is_absolute():
        raise WorkspacePreparationError("GITHUB_ENV must be an absolute path")
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise WorkspacePreparationError("GITHUB_ENV does not exist") from error
    if os.path.normcase(os.path.abspath(path)) != os.path.normcase(str(resolved)) or not resolved.is_file():
        raise WorkspacePreparationError("GITHUB_ENV must be a regular file without symlink traversal")
    values = {
        "FULLMAG_CI_FRONTEND_WORKSPACE_ROOT": str(frontend_root),
        "FULLMAG_CI_BUILD_STORAGE_ROOT": str(build_storage_root),
    }
    if any("\n" in value or "\r" in value or ".." in Path(value).parts for value in values.values()):
        raise WorkspacePreparationError("Resolved CI workspace paths must be normalized single-line paths")
    try:
        with resolved.open("a", encoding="utf-8", newline="\n") as stream:
            for name, value in values.items():
                stream.write(f"{name}={value}\n")
    except OSError as error:
        raise WorkspacePreparationError("Cannot append resolved workspace paths to GITHUB_ENV") from error


def prepare() -> dict:
    script_path = Path(__file__).resolve(strict=True)
    repo = script_path.parents[2]
    source_sha = _verify_github_checkout(repo)
    layout = _resolve_layout(repo)
    _, build_storage_root, frontend_root = _resolved_layout_roots(repo, layout)
    # Preserve normalized status paths even if manifest admission fails.
    _append_github_environment(frontend_root, build_storage_root)

    manifests = _manifest_sources(repo)
    records = []
    staged = []
    for relative, content in manifests:
        digest = hashlib.sha256(content).hexdigest()
        destination = _destination(frontend_root, build_storage_root, relative)
        _preflight_destination(frontend_root, destination)
        records.append({"path": relative, "sha256": digest, "size_bytes": len(content)})
        staged.append((destination, content, digest))

    manifest_set_bytes = json.dumps(records, sort_keys=True, separators=(",", ":")).encode("utf-8")
    metadata = {
        "schema": 1,
        "source_sha": source_sha,
        "source_manifest_set_sha256": hashlib.sha256(manifest_set_bytes).hexdigest(),
        "manifests": records,
    }
    metadata_bytes = (json.dumps(metadata, sort_keys=True, indent=2) + "\n").encode("utf-8")
    metadata_target = _destination(
        frontend_root, build_storage_root, "pnpm-workspace-manifests.json"
    )
    _preflight_destination(frontend_root, metadata_target)

    for destination, content, expected_digest in staged:
        _write_exact_bytes(frontend_root, destination, content)
        if hashlib.sha256(destination.read_bytes()).hexdigest() != expected_digest:
            raise WorkspacePreparationError(f"Staged manifest verification failed: {destination}")
    _write_exact_bytes(frontend_root, metadata_target, metadata_bytes)
    return {
        "frontend_root": str(frontend_root),
        "build_storage_root": str(build_storage_root),
        "source_sha": source_sha,
        "manifest_count": len(records),
        "source_manifest_set_sha256": metadata["source_manifest_set_sha256"],
    }


def main() -> int:
    try:
        result = prepare()
    except (OSError, WorkspacePreparationError) as error:
        print(f"[eigensolve UI workspace] {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
