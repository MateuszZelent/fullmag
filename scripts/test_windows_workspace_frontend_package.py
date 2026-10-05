"""Contract tests for isolated native frontend workspace staging.

These tests exercise only file selection, source identity and link topology.
They never invoke pnpm, Next, Cargo, a solver or a Windows launcher.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import stat
import sys

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent / "windows"))
import stage_workspace_frontend as staging


def test_frozen_source_is_copied_into_writable_frontend(tmp_path: Path):
    source = tmp_path / "frozen.ts"
    destination = tmp_path / "staged" / "live.ts"
    source.write_text("export const live = 1;\n")
    source.chmod(stat.S_IREAD)
    try:
        staging._copy_regular_file(source, destination)
        assert destination.stat().st_mode & stat.S_IWUSR
        destination.write_text("export const live = 2;\n")
        replacement = destination.with_suffix(".tmp")
        replacement.write_text("export const live = 3;\n")
        replacement.replace(destination)
        assert "= 1" in source.read_text()
        assert "= 3" in destination.read_text()
    finally:
        source.chmod(stat.S_IREAD | stat.S_IWRITE)


def _write(path: Path, contents: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(contents, bytes):
        path.write_bytes(contents)
    else:
        path.write_text(contents, encoding="utf-8")


def _fixture(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "checkout"
    build_root = tmp_path / "storage" / "builds" / "worktree" / "windows-native-fdm-cpu"
    build_root.mkdir(parents=True)
    _write(repo / "package.json", '{"name":"fullmag","private":true}\n')
    _write(repo / "pnpm-workspace.yaml", "packages:\n  - apps/*\n")
    _write(
        repo / "pnpm-lock.yaml",
        """lockfileVersion: '9.0'

importers:

  .:
    devDependencies: {}

  apps/control-room:
    dependencies: {}

  apps/desktop:
    dependencies: {}

snapshots:
  fake@1.0.0: {}
""",
    )
    control_room = repo / "apps" / "control-room"
    _write(control_room / "package.json", '{"name":"@fullmag/control-room"}\n')
    _write(control_room / "next.config.ts", "export default {};\n")
    _write(control_room / "tsconfig.json", '{"compilerOptions":{"noEmit":true}}\n')
    _write(control_room / "next-env.d.ts", "/// <reference types=\"next\" />\n")
    _write(control_room / "src" / "live.ts", "export const live = 1;\n")
    _write(control_room / "app" / "page.tsx", "export default function Page() { return null; }\n")
    _write(control_room / "public" / "icon.svg", "<svg />\n")
    _write(control_room / "scripts" / "watch.mjs", "console.log('watch');\n")
    _write(control_room / "src" / "untracked-source.ts", "export const untracked = true;\n")
    _write(control_room / "config" / "runtime.json", '{"api":"http://localhost"}\n')
    for generated in (
        "node_modules/ignored.js",
        "out/index.html",
        ".next/BUILD_ID",
        ".next-control-room-3197/BUILD_ID",
        ".next-audit-target-smoke-fixture/BUILD_ID",
        ".fullmag/session.json",
        "target/debug/fullmag",
        "artifacts/result.json",
        "storybook-static/index.html",
    ):
        _write(control_room / generated, "generated\n")
    _write(control_room / "tsconfig.tsbuildinfo", "generated\n")
    _write(repo / "apps" / "runner-console" / "package.json", '{"name":"@fullmag/runner-console"}\n')
    _write(repo / "apps" / "desktop" / "package.json", '{"name":"@fullmag/desktop"}\n')
    return repo, build_root


def _assert_link(path: Path, target: Path) -> None:
    assert staging._is_reparse_point(path), path
    assert path.resolve() == target.resolve()


@pytest.fixture
def frozen_frontend(tmp_path):
    from windows import build_snapshot

    repo, build_root = _fixture(tmp_path)
    _write(repo / "Cargo.toml", "[workspace]\nmembers = []\n")
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=Staging fixture",
         "-c", "user.email=staging@example.invalid", "commit", "-qm", "fixture"],
        check=True, capture_output=True,
    )
    snapshot = build_snapshot.create_snapshot(repo, build_root)
    try:
        yield repo, build_root, snapshot
    finally:
        for path in (build_root / "source-snapshots").rglob("*"):
            if path.is_file() and not path.is_symlink():
                path.chmod(stat.S_IREAD | stat.S_IWRITE)


def test_verified_snapshot_can_stage_frontend_inside_build_root(frozen_frontend):
    repo, build_root, snapshot = frozen_frontend
    _write(repo / "apps/control-room/src/live.ts", "changed after capture\n")
    result = staging.stage_workspace_frontend(
        snapshot["source_root"], build_root, mode="dev", web_port=3211,
        source_snapshot_record=snapshot["record_path"],
    )
    staged = Path(result["app_root"]) / "src/live.ts"
    assert staged.read_text() == "export const live = 1;\n"
    assert staged.stat().st_mode & stat.S_IWUSR
    manifest = json.loads(Path(result["manifest_path"]).read_text())
    assert manifest["build_source_snapshot"]["inventory_sha256"] == snapshot["inventory_sha256"]


@pytest.mark.parametrize("invalid", ["missing", "wrong-source", "tampered"])
def test_nested_frontend_source_requires_matching_intact_snapshot(frozen_frontend, invalid):
    repo, build_root, snapshot = frozen_frontend
    source = Path(snapshot["source_root"])
    record = snapshot["record_path"]
    if invalid == "missing":
        record = None
    elif invalid == "wrong-source":
        source = repo
    else:
        tampered = source / "apps/control-room/src/live.ts"
        tampered.chmod(stat.S_IREAD | stat.S_IWRITE)
        tampered.write_text("tampered frozen input\n")
    with pytest.raises(staging.StageError):
        staging.stage_workspace_frontend(
            source, build_root, mode="dev", source_snapshot_record=record,
        )
    assert not (build_root / "frontend-sources").exists()


def test_static_staging_is_fresh_hash_pinned_and_excludes_generated_trees(tmp_path):
    repo, build_root = _fixture(tmp_path)
    preserved = build_root / "frontend-sources" / "previous" / "keep.txt"
    _write(preserved, "preserve\n")

    result = staging.stage_workspace_frontend(repo, build_root, mode="static")
    workspace = Path(result["workspace_root"])
    app = Path(result["app_root"])
    cache = Path(result["frontend_root"])
    manifest_path = Path(result["manifest_path"])

    assert workspace.is_dir()
    assert app.is_dir()
    assert cache.is_dir()
    assert cache not in workspace.parents
    assert preserved.read_text(encoding="utf-8") == "preserve\n"
    assert (workspace / "package.json").is_file()
    assert (workspace / "pnpm-lock.yaml").is_file()
    assert (workspace / "apps" / "runner-console" / "package.json").is_file()
    assert (workspace / "apps" / "desktop" / "package.json").is_file()
    assert (app / "src" / "untracked-source.ts").is_file()
    assert not (app / "node_modules").exists()
    assert staging._is_reparse_point(app / "out")
    assert not (app / "target").exists()
    assert staging._is_reparse_point(app / ".artifacts")
    assert staging._is_reparse_point(app / "storybook-static")
    assert not (app / "tsconfig.tsbuildinfo").exists()

    _assert_link(app / ".fullmag-frontend", cache)
    _assert_link(app / "out", cache / "out")
    _assert_link(app / ".next", cache / "next" / "default")
    assert result["mode"] == "static"
    assert result["live_directories"] == []

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["schema"] == staging.SCHEMA
    assert manifest["source_inventory_sha256"] == result["source_inventory_sha256"]
    assert hashlib.sha256(manifest_path.read_bytes()).hexdigest() == result["manifest_sha256"]
    assert any(
        item["path"] == "apps/control-room/src/untracked-source.ts"
        for item in manifest["source_files"]
    )
    assert any(path.endswith("apps/control-room/node_modules") for path in manifest["excluded_paths"])
    assert any(path.endswith("apps/control-room/.next") for path in manifest["excluded_paths"])


def test_dev_staging_copies_live_source_and_uses_port_specific_cache(tmp_path):
    repo, build_root = _fixture(tmp_path)
    result = staging.stage_workspace_frontend(repo, build_root, mode="dev", web_port=3201)
    workspace = Path(result["workspace_root"])
    app = Path(result["app_root"])
    cache = Path(result["frontend_root"])

    for directory_name in staging.LIVE_DEV_DIRECTORIES:
        staged_directory = app / directory_name
        assert staged_directory.is_dir()
        assert not staging._is_reparse_point(staged_directory)
        assert any(staged_directory.rglob("*")), staged_directory
    assert (app / "next.config.ts").is_file()
    assert not (app / "node_modules").exists()
    assert staging._is_reparse_point(app / "out")
    _assert_link(app / ".next-control-room-3201", cache / "next" / "dev-3201")
    assert result["mode"] == "dev"
    assert result["web_port"] == 3201
    assert len(result["live_directories"]) == 4

    source_file = repo / "apps" / "control-room" / "src" / "live.ts"
    source_file.write_text("export const live = 2;\n", encoding="utf-8")
    assert (app / "src" / "live.ts").read_text(encoding="utf-8") == "export const live = 1;\n"
    # Editors commonly save by replacing the inode instead of modifying it.
    replacement = source_file.with_suffix(".tmp")
    replacement.write_text("export const live = 3;\n", encoding="utf-8")
    replacement.replace(source_file)
    assert (app / "src" / "live.ts").read_text(encoding="utf-8") == "export const live = 1;\n"
    assert workspace != repo
    manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest["source_mirror"]["schema"] == "fullmag.dev-source-mirror.v1"
    assert manifest["source_mirror"]["directories"] == list(staging.LIVE_DEV_DIRECTORIES)
    assert manifest["source_mirror"]["copies_are_regular_files"] is True
    assert result["source_mirror"] == manifest["source_mirror"]
    assert not any(item["purpose"] == "live-source" for item in manifest["managed_links"])


def test_lock_importer_parser_does_not_treat_snapshot_keys_as_apps(tmp_path):
    lockfile = tmp_path / "pnpm-lock.yaml"
    _write(
        lockfile,
        """lockfileVersion: '9.0'
importers:
  .:
    dependencies: {}
  apps/control-room:
    dependencies: {}
snapshots:
  apps/fake@1.0.0: {}
  other: {}
""",
    )
    assert staging._parse_lock_importers(lockfile) == ["apps/control-room"]


def test_cli_emits_machine_readable_stage_identity(tmp_path):
    repo, build_root = _fixture(tmp_path)
    result = subprocess.run(
        [
            sys.executable,
            str(Path(staging.__file__).resolve()),
            "--repo-root",
            str(repo),
            "--build-root",
            str(build_root),
            "--mode",
            "dev",
            "--web-port",
            "3210",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["mode"] == "dev"
    assert payload["web_port"] == 3210
    assert Path(payload["workspace_root"]).is_dir()
    assert Path(payload["manifest_path"]).is_file()
    assert len(payload["manifest_sha256"]) == 64


def test_staging_rejects_repository_build_overlap_and_invalid_port(tmp_path):
    repo, build_root = _fixture(tmp_path)
    inside_build = repo / "inside-build"
    inside_build.mkdir()
    with pytest.raises(staging.StageError, match="outside the repository"):
        staging.stage_workspace_frontend(repo, inside_build, mode="static")
    with pytest.raises(staging.StageError, match="1 to 65535"):
        staging.stage_workspace_frontend(repo, build_root, mode="dev", web_port=0)


def test_generated_entries_are_excluded_before_windows_metadata_access(tmp_path, monkeypatch):
    repo, build_root = _fixture(tmp_path)
    _write(repo / "apps/control-room/storybook-static/generated.txt", "keep generated")
    _write(repo / "apps/control-room/.artifacts/proof.json", "keep proof")
    original = Path.is_dir
    def guarded_is_dir(path):
        if path.name in ("storybook-static", ".artifacts") and path.parent == repo / "apps/control-room":
            raise OSError(1920, "Cannot follow generated reparse metadata")
        return original(path)
    monkeypatch.setattr(Path, "is_dir", guarded_is_dir)
    result = staging.stage_workspace_frontend(repo, build_root, mode="static")
    assert not (Path(result["app_root"]) / "out/generated.txt").exists()
    assert (repo / "apps/control-room/.artifacts/proof.json").read_text() == "keep proof"
