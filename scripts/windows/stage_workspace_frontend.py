#!/usr/bin/env python3
"""Stage an isolated Windows Control Room workspace without touching the checkout.

The native Windows launcher may need a fresh frontend workspace when the
checkout contains real ``node_modules``/Next output or when the requested
development run must observe edits made in the checkout.  This helper has one
deliberately narrow responsibility: select the frontend inputs, copy or link
them into a new directory below the already-resolved build root, and emit a
hashable manifest.  It does not install packages, build Next, start a server,
or remove an existing path.

``static`` copies the complete Control Room source tree.  ``dev`` copies the
workspace metadata, application configuration, and the four live source
directories into the isolated workspace.  A separate Node relay keeps those
regular-file copies current while Next is running; the staged tree therefore
does not depend on Next/Watchpack following a junction into the checkout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import uuid
from dataclasses import dataclass
from typing import Iterable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


SCHEMA = "fullmag.native-workspace-frontend-source.v1"
DEFAULT_DEV_PORT = 3197
CONTROL_ROOM_RELATIVE = Path("apps") / "control-room"
WORKSPACE_METADATA = (
    Path("package.json"),
    Path("pnpm-lock.yaml"),
    Path("pnpm-workspace.yaml"),
)
LIVE_DEV_DIRECTORIES = ("src", "app", "public", "scripts")

# These names are all generated or dependency trees in the current Control
# Room checkout.  Prefix handling is intentional: previous audit/dev runs
# use names such as .next-control-room-3100 and .next-audit-target-smoke-... .
EXCLUDED_DIRECTORY_NAMES = frozenset(
    {
        ".fullmag",
        ".fullmag-frontend",
        ".next",
        ".next-audit",
        "artifacts",
        ".artifacts",
        "node_modules",
        "out",
        "storybook-static",
        "target",
    }
)
EXCLUDED_DIRECTORY_PREFIXES = (".fullmag-", ".next-")
EXCLUDED_FILE_SUFFIXES = (".tsbuildinfo",)
REPARSE_POINT_ATTRIBUTE = 0x400


class StageError(ValueError):
    """Raised when a source or destination violates the staging contract."""


@dataclass(frozen=True)
class SourceEntry:
    source: Path
    relative: Path
    mode: str


def _is_reparse_point(path: Path) -> bool:
    try:
        stat_result = path.lstat()
    except FileNotFoundError:
        return False
    return path.is_symlink() or bool(
        getattr(stat_result, "st_file_attributes", 0) & REPARSE_POINT_ATTRIBUTE
    )


def _lexists(path: Path) -> bool:
    return os.path.lexists(str(path))


def _same_or_inside(candidate: Path, parent: Path) -> bool:
    candidate_text = os.path.normcase(os.path.abspath(str(candidate)))
    parent_text = os.path.normcase(os.path.abspath(str(parent)))
    return candidate_text == parent_text or candidate_text.startswith(
        parent_text.rstrip("\\/") + os.sep
    )


def _resolve_existing_directory(value: str | os.PathLike[str], label: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise StageError(f"{label} must be absolute: {path}")
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise StageError(f"{label} cannot be resolved: {path}") from error
    if not resolved.is_dir():
        raise StageError(f"{label} is not a directory: {resolved}")
    if _is_reparse_point(path):
        raise StageError(f"{label} must be a real directory, not a reparse point: {path}")
    return resolved


def _require_regular_file(path: Path, label: str) -> None:
    if _is_reparse_point(path):
        raise StageError(f"{label} is a reparse point: {path}")
    try:
        is_file = path.is_file()
    except OSError as error:
        raise StageError(f"Cannot inspect {label}: {path}") from error
    if not is_file:
        raise StageError(f"{label} is missing or not a regular file: {path}")


def _require_real_directory(path: Path, label: str) -> None:
    if _is_reparse_point(path):
        raise StageError(f"{label} is a reparse point: {path}")
    if not path.is_dir():
        raise StageError(f"{label} is missing or not a directory: {path}")


def _is_excluded_directory(name: str) -> bool:
    lowered = name.casefold()
    return lowered in EXCLUDED_DIRECTORY_NAMES or any(
        lowered.startswith(prefix) for prefix in EXCLUDED_DIRECTORY_PREFIXES
    )


def _is_excluded_file(name: str) -> bool:
    lowered = name.casefold()
    return any(lowered.endswith(suffix) for suffix in EXCLUDED_FILE_SUFFIXES)


def _walk_regular_files(
    root: Path,
    relative_root: Path,
    *,
    skip_directories: Sequence[str] = (),
) -> tuple[list[tuple[Path, Path]], list[str]]:
    """Enumerate regular files and explicit generated exclusions.

    The walk never follows a reparse point.  A reparse entry is skipped only
    when its name is one of the explicit generated exclusions; any other
    reparse point fails closed instead of silently copying an unexpected tree.
    """

    _require_real_directory(root, "source directory")
    skip = {name.casefold() for name in skip_directories}
    files: list[tuple[Path, Path]] = []
    exclusions: list[str] = []
    stack: list[tuple[Path, Path]] = [(root, relative_root)]
    while stack:
        current, current_relative = stack.pop()
        try:
            entries = sorted(current.iterdir(), key=lambda item: item.name.casefold(), reverse=True)
        except OSError as error:
            raise StageError(f"Cannot enumerate source directory: {current}") from error
        for entry in entries:
            relative = current_relative / entry.name
            # Generated entries may be dangling LX/Windows reparse points.
            # Exclude by name before asking Windows to follow their metadata.
            if _is_excluded_directory(entry.name) or entry.name.casefold() in skip:
                exclusions.append(relative.as_posix())
                continue
            if entry.is_dir() and not _is_reparse_point(entry):
                if _is_excluded_directory(entry.name) or entry.name.casefold() in skip:
                    exclusions.append(relative.as_posix())
                    continue
                stack.append((entry, relative))
                continue
            if _is_excluded_directory(entry.name):
                exclusions.append(relative.as_posix())
                continue
            if _is_reparse_point(entry):
                raise StageError(f"Unexpected source reparse point: {entry}")
            if not entry.is_file():
                raise StageError(f"Unsupported source entry (not a regular file): {entry}")
            if _is_excluded_file(entry.name):
                exclusions.append(relative.as_posix())
                continue
            files.append((entry, relative))
    files.sort(key=lambda item: item[1].as_posix())
    exclusions.sort()
    return files, exclusions


def _sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
    except OSError as error:
        raise StageError(f"Cannot hash source file: {path}") from error
    return digest.hexdigest(), size


def _source_digest(entries: Iterable[dict[str, object]]) -> str:
    digest = hashlib.sha256()
    for entry in sorted(entries, key=lambda item: str(item["path"])):
        digest.update(
            (
                f"{entry['path']}\0{entry['size']}\0{entry['sha256']}\0"
                f"{entry['mode']}\n"
            ).encode("utf-8")
        )
    return digest.hexdigest()


def _parse_lock_importers(lockfile: Path) -> list[str]:
    importers: list[str] = []
    in_importers = False
    for line in lockfile.read_text(encoding="utf-8").splitlines():
        if line == "importers:":
            in_importers = True
            continue
        if in_importers and line and not line.startswith(" "):
            break
        if not in_importers:
            continue
        if not line.startswith("  ") or line.startswith("    "):
            continue
        candidate = line[2:].strip()
        if candidate.endswith(":") and not candidate.startswith("#"):
            value = candidate[:-1]
            if value and value != "." and ":" not in value:
                importers.append(value)
    return sorted(set(importers))


def _direct_app_package_manifests(repo_root: Path, lock_importers: Sequence[str]) -> list[Path]:
    apps_root = repo_root / "apps"
    _require_real_directory(apps_root, "apps workspace directory")
    manifests: list[Path] = []
    try:
        app_directories = sorted(
            (path for path in apps_root.iterdir() if path.is_dir()),
            key=lambda path: path.name.casefold(),
        )
    except OSError as error:
        raise StageError(f"Cannot enumerate apps workspace directory: {apps_root}") from error
    for app_directory in app_directories:
        if _is_reparse_point(app_directory):
            raise StageError(f"Unexpected apps workspace reparse point: {app_directory}")
        manifest = app_directory / "package.json"
        if app_directory.name == "desktop" and "apps/desktop" not in lock_importers:
            continue
        if _lexists(manifest):
            _require_regular_file(manifest, "app package manifest")
            manifests.append(manifest)
    return manifests


def _make_directory_link(link: Path, target: Path) -> str:
    """Create a directory junction on Windows, or a symlink for test hosts."""

    if _lexists(link):
        raise StageError(f"Refusing to replace an existing staged path: {link}")
    if not target.is_dir() or _is_reparse_point(target):
        raise StageError(f"Managed link target must be a real directory: {target}")
    link.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "junction creation failed").strip()
            raise StageError(f"Cannot create directory junction {link} -> {target}: {detail}")
        kind = "junction"
    else:
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as error:
            raise StageError(f"Cannot create directory symlink {link} -> {target}") from error
        kind = "directory-symlink"
    if not _is_reparse_point(link):
        raise StageError(f"Managed link was not created as a reparse link: {link}")
    try:
        resolved_link = link.resolve(strict=True)
        resolved_target = target.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise StageError(f"Cannot resolve managed link {link}") from error
    if not _same_or_inside(resolved_link, resolved_target) or not _same_or_inside(
        resolved_target, resolved_link
    ):
        raise StageError(f"Managed link target mismatch: {link} -> {resolved_link}; expected {resolved_target}")
    return kind


def _copy_regular_file(source: Path, destination: Path) -> None:
    _require_regular_file(source, "source file")
    if _lexists(destination):
        raise StageError(f"Refusing to replace an existing staged file: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination, follow_symlinks=False)
    try:
        shutil.copystat(source, destination, follow_symlinks=False)
        # Native build snapshots are read-only. Next and the HMR relay own
        # this separate working copy and must be able to replace its files.
        destination.chmod(destination.stat().st_mode | stat.S_IWUSR)
    except OSError as error:
        raise StageError(f"Cannot preserve staged file metadata: {destination}") from error


def _assert_live_tree_has_no_reparse(path: Path) -> None:
    files, _ = _walk_regular_files(path, Path(path.name))
    # The walk itself rejects all non-generated reparse points.  Keep the
    # resulting list unused: this function is a named boundary for dev links.
    del files


def _prepare_frontend_cache(cache_root: Path, *, mode: str, web_port: int | None) -> list[dict[str, str]]:
    if _lexists(cache_root):
        raise StageError(f"Refusing to replace an existing frontend cache path: {cache_root}")
    cache_root.mkdir(parents=True, exist_ok=False)
    targets = {
        "": cache_root,
        "out": cache_root / "out",
        "next/default": cache_root / "next" / "default",
        "next/audit": cache_root / "next" / "audit",
        "artifacts": cache_root / "artifacts",
        "storybook-static": cache_root / "storybook-static",
        "test-cache/vite": cache_root / "test-cache" / "vite",
    }
    if mode == "dev":
        assert web_port is not None
        targets[f"next/dev-{web_port}"] = cache_root / "next" / f"dev-{web_port}"
    for target in targets.values():
        target.mkdir(parents=True, exist_ok=True)
    return [{"relative": relative, "absolute": str(path)} for relative, path in targets.items()]


def _stage_identity(
    source_entries: Sequence[SourceEntry], *, source_root: Path
) -> tuple[list[dict[str, object]], str]:
    inventory: list[dict[str, object]] = []
    for entry in source_entries:
        digest, size = _sha256_file(entry.source)
        inventory.append(
            {
                "path": entry.relative.as_posix(),
                "source": str(entry.source),
                "size": size,
                "sha256": digest,
                "mode": entry.mode,
            }
        )
    # Keep source_root in the identity without hashing machine-specific path
    # strings into every file entry.  The caller stores the absolute source
    # root in the manifest as an audit aid.
    del source_root
    return inventory, _source_digest(inventory)


def _verify_source_identity(
    source_root: Path,
    *,
    mode: str,
    lock_importers: Sequence[str],
    before: Sequence[dict[str, object]],
) -> None:
    before_by_path = {str(entry["path"]): entry for entry in before}
    after_entries, _, _ = _build_source_entries(
        source_root,
        mode=mode,
        lock_importers=lock_importers,
    )
    after, _ = _stage_identity(after_entries, source_root=source_root)
    after_by_path = {str(entry["path"]): entry for entry in after}
    if len(after_by_path) != len(before_by_path) or any(
        after_by_path.get(path) != before_by_path.get(path)
        for path in set(before_by_path) | set(after_by_path)
    ):
        changed = sorted(
            {
                path
                for path in set(before_by_path) | set(after_by_path)
                if before_by_path.get(path) != after_by_path.get(path)
            }
        )
        detail = ", ".join(changed[:8])
        if len(changed) > 8:
            detail += f" (+{len(changed) - 8} more)"
        raise StageError(f"Source changed during frontend staging: {detail}")


def _verify_staged_copy_identity(
    source_entries: Sequence[SourceEntry],
    before: Sequence[dict[str, object]],
    workspace_root: Path,
) -> None:
    before_by_path = {str(entry["path"]): entry for entry in before}
    for entry in source_entries:
        expected = before_by_path[entry.relative.as_posix()]
        staged = workspace_root / entry.relative
        digest, size = _sha256_file(staged)
        if digest != expected["sha256"] or size != expected["size"]:
            raise StageError(f"Staged frontend file mismatch: {entry.relative}")


def _build_source_entries(
    repo_root: Path,
    *,
    mode: str,
    lock_importers: Sequence[str],
) -> tuple[list[SourceEntry], list[str], list[str]]:
    entries_by_relative: dict[str, SourceEntry] = {}
    exclusions: set[str] = set()
    selected_live_directories: list[str] = []

    def add(source: Path, relative: Path, entry_mode: str) -> None:
        _require_regular_file(source, "selected frontend source")
        key = relative.as_posix()
        existing = entries_by_relative.get(key)
        if existing is not None and existing.source != source:
            raise StageError(f"Conflicting frontend source selection for {relative}")
        entries_by_relative[key] = SourceEntry(source, relative, entry_mode)

    for relative in WORKSPACE_METADATA:
        source = repo_root / relative
        _require_regular_file(source, f"workspace metadata {relative}")
        add(source, relative, "workspace-metadata")

    control_room = repo_root / CONTROL_ROOM_RELATIVE
    _require_real_directory(control_room, "Control Room source directory")
    skip_live = LIVE_DEV_DIRECTORIES if mode == "dev" else ()
    app_files, app_exclusions = _walk_regular_files(
        control_room,
        CONTROL_ROOM_RELATIVE,
        skip_directories=skip_live,
    )
    exclusions.update(app_exclusions)
    for source, relative in app_files:
        add(source, relative, "control-room-copy")

    if mode == "dev":
        for directory_name in LIVE_DEV_DIRECTORIES:
            source_directory = control_room / directory_name
            _require_real_directory(source_directory, f"Control Room live directory {directory_name}")
            _assert_live_tree_has_no_reparse(source_directory)
            selected_live_directories.append((CONTROL_ROOM_RELATIVE / directory_name).as_posix())
            live_files, live_exclusions = _walk_regular_files(
                source_directory,
                CONTROL_ROOM_RELATIVE / directory_name,
            )
            exclusions.update(live_exclusions)
            for source, relative in live_files:
                add(source, relative, "dev-source-mirror")

    for manifest in _direct_app_package_manifests(repo_root, lock_importers):
        relative = manifest.relative_to(repo_root)
        # The complete Control Room walk already selected this manifest.
        add(manifest, relative, "app-package-manifest")

    entries = sorted(entries_by_relative.values(), key=lambda entry: entry.relative.as_posix())
    return entries, sorted(exclusions), sorted(selected_live_directories)


def _validate_port(web_port: int | str | None, *, mode: str) -> int | None:
    if mode == "static":
        if web_port is None:
            return None
    if web_port is None:
        return DEFAULT_DEV_PORT
    try:
        value = int(web_port)
    except (TypeError, ValueError) as error:
        raise StageError("Development web port must be an integer from 1 to 65535") from error
    if not 1 <= value <= 65535:
        raise StageError("Development web port must be an integer from 1 to 65535")
    return value


def stage_workspace_frontend(
    repo_root: str | os.PathLike[str],
    build_root: str | os.PathLike[str],
    *,
    mode: str = "static",
    web_port: int | str | None = None,
    source_snapshot_record: str | os.PathLike[str] | None = None,
) -> dict[str, object]:
    """Create and describe one fresh isolated frontend staging root."""

    if mode not in {"static", "dev"}:
        raise StageError("Frontend staging mode must be static or dev")
    source_root = _resolve_existing_directory(repo_root, "repository root")
    canonical_build_root = _resolve_existing_directory(build_root, "canonical build root")
    snapshot = None
    if source_snapshot_record is not None:
        from windows.build_snapshot import SnapshotError, verify_snapshot

        try:
            snapshot = verify_snapshot(source_snapshot_record, canonical_build_root)
        except (OSError, ValueError, SnapshotError) as error:
            raise StageError(f"Invalid frontend source snapshot: {error}") from error
        if Path(snapshot["source_root"]) != source_root:
            raise StageError("Snapshot record does not identify the requested frontend source root")
    if _same_or_inside(canonical_build_root, source_root) or (
        _same_or_inside(source_root, canonical_build_root) and snapshot is None
    ):
        raise StageError("Canonical build root must be outside the repository root")
    port = _validate_port(web_port, mode=mode)

    lockfile = source_root / "pnpm-lock.yaml"
    _require_regular_file(lockfile, "pnpm lockfile")
    lock_importers = _parse_lock_importers(lockfile)
    source_entries, exclusions, live_directories = _build_source_entries(
        source_root,
        mode=mode,
        lock_importers=lock_importers,
    )
    before, source_inventory_sha256 = _stage_identity(source_entries, source_root=source_root)

    sources_root = canonical_build_root / "frontend-sources"
    if _lexists(sources_root) and _is_reparse_point(sources_root):
        raise StageError(f"Frontend source staging root must be a real directory: {sources_root}")
    sources_root.mkdir(parents=True, exist_ok=True)
    stage_id = uuid.uuid4().hex
    stage_root = sources_root / stage_id
    stage_root.mkdir(parents=False, exist_ok=False)
    workspace_root = stage_root / "workspace"
    workspace_root.mkdir()

    cache_parent = canonical_build_root / "frontend" / "workspace"
    for parent in (canonical_build_root / "frontend", cache_parent):
        if _lexists(parent) and _is_reparse_point(parent):
            raise StageError(f"Frontend cache parent must be a real directory: {parent}")
    cache_parent.mkdir(parents=True, exist_ok=True)
    frontend_cache_root = cache_parent / stage_id
    cache_locations = _prepare_frontend_cache(frontend_cache_root, mode=mode, web_port=port)

    try:
        for entry in source_entries:
            destination = workspace_root / entry.relative
            _copy_regular_file(entry.source, destination)

        app_root = workspace_root / CONTROL_ROOM_RELATIVE
        link_specs: list[tuple[Path, Path, str]] = [
            (app_root / ".fullmag-frontend", frontend_cache_root, "managed-frontend-root"),
            (app_root / "out", frontend_cache_root / "out", "managed-static-output"),
            (app_root / ".next", frontend_cache_root / "next" / "default", "managed-next-default"),
            (app_root / ".artifacts", frontend_cache_root / "artifacts", "managed-artifacts"),
            (
                app_root / "storybook-static",
                frontend_cache_root / "storybook-static",
                "managed-storybook-output",
            ),
        ]
        if mode == "dev":
            assert port is not None
            link_specs.append(
                (
                    app_root / f".next-control-room-{port}",
                    frontend_cache_root / "next" / f"dev-{port}",
                    "managed-next-dev",
                )
            )
        links: list[dict[str, str]] = []
        for link, target, purpose in link_specs:
            link_kind = _make_directory_link(link, target)
            links.append(
                {
                    "path": str(link),
                    "target": str(target),
                    "kind": link_kind,
                    "purpose": purpose,
                }
            )

        _verify_staged_copy_identity(source_entries, before, workspace_root)
        _verify_source_identity(
            source_root,
            mode=mode,
            lock_importers=lock_importers,
            before=before,
        )
    except BaseException:
        # The helper never deletes a partially created stage or cache.  The
        # caller can inspect the fresh directory and decide its lifecycle.
        raise

    manifest: dict[str, object] = {
        "schema": SCHEMA,
        "stage_id": stage_id,
        "mode": mode,
        "source_root": str(source_root),
        "build_root": str(canonical_build_root),
        "stage_root": str(stage_root),
        "workspace_root": str(workspace_root),
        "app_root": str(workspace_root / CONTROL_ROOM_RELATIVE),
        "frontend_root": str(frontend_cache_root),
        "frontend_cache_root": str(frontend_cache_root),
        "web_port": port,
        "lock_importers": lock_importers,
        "source_selection": "filesystem-current-selected-inputs",
        "untracked_current_files_included": True,
        "live_directories": live_directories,
        "source_mirror": {
            "schema": "fullmag.dev-source-mirror.v1",
            "source_root": str(source_root / CONTROL_ROOM_RELATIVE),
            "target_root": str(workspace_root / CONTROL_ROOM_RELATIVE),
            "directories": list(LIVE_DEV_DIRECTORIES) if mode == "dev" else [],
            "copies_are_regular_files": True,
        },
        "excluded_paths": exclusions,
        "frontend_cache_layout": cache_locations,
        "managed_links": links,
        "source_inventory_sha256": source_inventory_sha256,
        "source_files": before,
    }
    if snapshot is not None:
        manifest["source_selection"] = "verified-frozen-snapshot-selected-inputs"
        manifest["build_source_snapshot"] = {
            key: snapshot[key] for key in ("record_path", "inventory_sha256", "source_root")
        }
    manifest_path = stage_root / "frontend-source-manifest.json"
    manifest_bytes = (json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode(
        "utf-8"
    )
    try:
        with manifest_path.open("xb") as stream:
            stream.write(manifest_bytes)
    except OSError as error:
        raise StageError(f"Cannot write frontend source manifest: {manifest_path}") from error
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
    return {
        "schema": SCHEMA,
        "stage_id": stage_id,
        "mode": mode,
        "source_root": str(source_root),
        "build_root": str(canonical_build_root),
        "stage_root": str(stage_root),
        "workspace_root": str(workspace_root),
        "app_root": str(workspace_root / CONTROL_ROOM_RELATIVE),
        "frontend_root": str(frontend_cache_root),
        "frontend_cache_root": str(frontend_cache_root),
        "manifest_path": str(manifest_path),
        "manifest_file": str(manifest_path),
        "manifest_sha256": manifest_sha256,
        "source_inventory_sha256": source_inventory_sha256,
        "source_file_count": len(before),
        "web_port": port,
        "live_directories": live_directories,
        "source_mirror": {
            "schema": "fullmag.dev-source-mirror.v1",
            "source_root": str(source_root / CONTROL_ROOM_RELATIVE),
            "target_root": str(workspace_root / CONTROL_ROOM_RELATIVE),
            "directories": list(LIVE_DEV_DIRECTORIES) if mode == "dev" else [],
            "copies_are_regular_files": True,
        },
        "managed_link_count": len(links),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--build-root", required=True)
    parser.add_argument("--mode", "--frontend-mode", choices=("static", "dev"), default="static")
    parser.add_argument("--web-port", type=int)
    parser.add_argument("--source-snapshot-record")
    args = parser.parse_args(argv)
    try:
        result = stage_workspace_frontend(
            args.repo_root,
            args.build_root,
            mode=args.mode,
            web_port=args.web_port,
            source_snapshot_record=args.source_snapshot_record,
        )
    except (OSError, StageError, ValueError) as error:
        print(f"[fullmag frontend staging] {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
