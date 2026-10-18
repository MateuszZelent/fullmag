"""Interpreted regression checks for native dependency workspace reuse."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

import fullmag_storage
from windows import stage_workspace_frontend
from frontend_source_workspace import (
    SourceWorkspaceError,
    _dependency_input_paths,
    prepare_source_workspace,
    validate_dependency_workspace,
)


PROFILE = fullmag_storage.WINDOWS_WORKSPACE_STORAGE_PROFILES["dev"]
SOURCE_PROFILE = "windows-control-room-source-check"
_STORAGE_ENVIRONMENT_KEYS = tuple(sorted(fullmag_storage.MANAGED_VARIABLES))


class FrontendSourceWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        temp_root = Path(tempfile.gettempdir()).resolve(strict=True)
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=".test-frontend-source-workspace-", dir=temp_root
        )
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.repo = self.root / "checkout"
        self.repo.mkdir()
        self.storage_root = self.root / "storage"
        self._previous_storage_environment = {
            name: os.environ.get(name) for name in _STORAGE_ENVIRONMENT_KEYS
        }
        self.addCleanup(self._restore_storage_environment)
        for name in _STORAGE_ENVIRONMENT_KEYS:
            os.environ.pop(name, None)
        os.environ["FULLMAG_PROJECT_STORAGE_ROOT"] = str(self.storage_root)

        self._write_source_fixture()
        self._git("init", "--quiet")
        self._git("config", "user.name", "Frontend source workspace tests")
        self._git("config", "user.email", "frontend-source-workspace@example.invalid")
        self._git("add", "-A")
        self._git("commit", "--quiet", "-m", "Create frontend source fixture")

        self.layout = fullmag_storage.resolve_layout(self.repo, SOURCE_PROFILE)
        os.environ["FULLMAG_BUILD_STORAGE_ROOT"] = self.layout["build_storage_root"]
        self.run_root = Path(self.layout["build_root"]) / "api-hygiene" / "run-001"
        self.run_root.mkdir(parents=True)
        self.native_layout = fullmag_storage.resolve_layout(self.repo, PROFILE)
        self.native_build_root = Path(self.native_layout["build_root"])
        self.native_build_root.mkdir(parents=True)
        self.native_stage = stage_workspace_frontend.stage_workspace_frontend(
            self.repo,
            self.native_build_root,
            mode="dev",
            web_port=3197,
        )
        self.native_workspace = Path(self.native_stage["workspace_root"])
        (self.native_workspace / "node_modules").mkdir()
        (self.native_workspace / "node_modules" / "root-dependency.marker").write_text(
            "root dependency data", encoding="utf-8"
        )
        self.native_app = self.native_workspace / "apps" / "control-room"
        (self.native_app / "node_modules").mkdir()
        (self.native_app / "node_modules" / "app-dependency.marker").write_text(
            "app dependency data", encoding="utf-8"
        )

    def _restore_storage_environment(self) -> None:
        for name, value in self._previous_storage_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def _git(self, *args: str) -> None:
        result = subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode:
            self.fail(f"Git fixture setup failed: {result.stderr.strip()}")

    def _write_source_fixture(self) -> None:
        files = {
            "package.json": '{"name":"fullmag-fixture","private":true}\n',
            "pnpm-lock.yaml": (
                "lockfileVersion: '9.0'\n"
                "importers:\n"
                "  .: {}\n"
                "  apps/control-room:\n"
                "    dependencies: {}\n"
                "  apps/desktop:\n"
                "    dependencies: {}\n"
            ),
            "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
            "apps/control-room/package.json": (
                '{"name":"@fullmag/control-room","private":true,"devDependencies":{}}\n'
            ),
            "apps/control-room/README.md": "fixture app source\n",
            "apps/control-room/src/index.ts": "export const source = 'current';\n",
            "apps/control-room/app/page.tsx": "export default function Page() { return null; }\n",
            "apps/control-room/public/robots.txt": "User-agent: *\nDisallow:\n",
            "apps/control-room/scripts/check.mjs": "process.exit(0);\n",
            "apps/desktop/package.json": '{"name":"@fullmag/desktop","private":true}\n',
        }
        for relative, contents in files.items():
            path = self.repo / Path(relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents, encoding="utf-8")

    def _prepare(self) -> dict[str, object]:
        return prepare_source_workspace(
            self.repo,
            self.layout,
            self.run_root,
            self.native_workspace,
        )

    def _stage_frozen_workspace(
        self,
        origin_repo: Path | None = None,
    ) -> tuple[dict[str, object], dict[str, object], Path]:
        from windows import build_snapshot

        snapshot = build_snapshot.create_snapshot(
            origin_repo or self.repo,
            self.native_build_root,
        )
        stage = stage_workspace_frontend.stage_workspace_frontend(
            Path(snapshot["source_root"]),
            self.native_build_root,
            mode="dev",
            web_port=3197,
            source_snapshot_record=snapshot["record_path"],
        )
        workspace = Path(stage["workspace_root"])
        (workspace / "node_modules").mkdir()
        (workspace / "node_modules" / "root-dependency.marker").write_text(
            "root dependency data", encoding="utf-8"
        )
        app = workspace / "apps" / "control-room"
        (app / "node_modules").mkdir()
        (app / "node_modules" / "app-dependency.marker").write_text(
            "app dependency data", encoding="utf-8"
        )
        return stage, snapshot, workspace

    def _dependency_input_snapshot(self) -> dict[str, bytes | None]:
        manifest = Path(self.native_stage["manifest_path"])
        paths = (
            self.repo / "package.json",
            self.repo / "pnpm-lock.yaml",
            self.repo / "pnpm-workspace.yaml",
            self.repo / "apps" / "control-room" / "package.json",
            self.repo / ".npmrc",
            self.repo / "apps" / "desktop" / "package.json",
            self.native_workspace / "package.json",
            self.native_workspace / "pnpm-lock.yaml",
            self.native_workspace / "pnpm-workspace.yaml",
            self.native_app / "package.json",
            self.native_workspace / ".npmrc",
            self.native_workspace / "apps" / "desktop" / "package.json",
            manifest,
            self.native_workspace / "node_modules" / "root-dependency.marker",
            self.native_app / "node_modules" / "app-dependency.marker",
        )
        return {
            str(path): path.read_bytes() if path.is_file() else None
            for path in paths
        }

    def test_reuses_same_checkout_dependencies_and_keeps_inputs_unchanged(self) -> None:
        before = self._dependency_input_snapshot()
        checked = validate_dependency_workspace(
            self.repo, self.layout, self.native_workspace
        )
        self.assertIn("package.json", checked["dependency_input_hashes"])
        self.assertIn("apps/desktop/package.json", checked["dependency_input_hashes"])

        result = self._prepare()
        app = Path(result["app"])
        dependencies = Path(result["dependencies"])
        workspace_root = Path(result["workspace_root"])

        self.assertTrue(app.is_dir())
        self.assertEqual(app, workspace_root / "apps" / "control-room")
        self.assertEqual(dependencies, app / "node_modules")
        self.assertEqual(dependencies.resolve(), (self.native_app / "node_modules").resolve())
        self.assertEqual(
            (workspace_root / "node_modules").resolve(),
            (self.native_workspace / "node_modules").resolve(),
        )
        self.assertEqual(result["dependency_mode"], "native_workspace_read_only")
        self.assertEqual(result["dependency_manifest"], self.native_stage["manifest_path"])
        self.assertEqual(result["dependency_manifest_sha256"], checked["dependency_manifest_sha256"])
        self.assertEqual(result["dependency_input_hashes"], checked["dependency_input_hashes"])
        source_manifest = Path(result["source_manifest"])
        self.assertTrue(source_manifest.is_file())
        self.assertEqual(source_manifest, workspace_root.parent / "frontend-source-manifest.json")
        self.assertEqual(result["dependency_workspace"], str(self.native_workspace))
        self.assertEqual(result["dependency_profile"], PROFILE)
        self.assertEqual(result["source_run_profile"], SOURCE_PROFILE)
        self.assertEqual(result["source_run_build_root"], self.layout["build_root"])
        self.assertEqual(
            (workspace_root / "pnpm-lock.yaml").read_bytes(),
            (self.repo / "pnpm-lock.yaml").read_bytes(),
        )
        self.assertEqual(self._dependency_input_snapshot(), before)

    def test_reuses_dependencies_from_a_verified_frozen_source_snapshot(self) -> None:
        stage, snapshot, workspace = self._stage_frozen_workspace()
        manifest = json.loads(Path(stage["manifest_path"]).read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["source_selection"],
            "verified-frozen-snapshot-selected-inputs",
        )
        self.assertEqual(
            manifest["build_source_snapshot"],
            {
                "record_path": snapshot["record_path"],
                "inventory_sha256": snapshot["inventory_sha256"],
                "source_root": snapshot["source_root"],
            },
        )

        checked = validate_dependency_workspace(self.repo, self.layout, workspace)
        self.assertEqual(checked["dependency_workspace"], str(workspace))
        self.assertEqual(
            checked["dependency_input_hashes"]["pnpm-lock.yaml"],
            hashlib.sha256((self.repo / "pnpm-lock.yaml").read_bytes()).hexdigest(),
        )

    def test_frozen_dependencies_must_match_current_checkout_inputs(self) -> None:
        _, _, workspace = self._stage_frozen_workspace()
        lockfile = self.repo / "pnpm-lock.yaml"
        original = lockfile.read_bytes()
        try:
            lockfile.write_bytes(original + b"# changed after snapshot\n")
            with self.assertRaises(SourceWorkspaceError):
                validate_dependency_workspace(self.repo, self.layout, workspace)
        finally:
            lockfile.write_bytes(original)

    def test_frozen_snapshot_from_another_checkout_is_rejected(self) -> None:
        foreign_repo = self.root / "foreign-frozen-checkout"
        shutil.copytree(self.repo, foreign_repo, ignore=shutil.ignore_patterns(".git"))
        subprocess.run(["git", "-C", str(foreign_repo), "init", "--quiet"], check=True)
        subprocess.run(
            ["git", "-C", str(foreign_repo), "config", "user.name", "Foreign frozen fixture"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(foreign_repo), "config", "user.email", "foreign-frozen@example.invalid"],
            check=True,
        )
        subprocess.run(["git", "-C", str(foreign_repo), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(foreign_repo), "commit", "--quiet", "-m", "Foreign frozen fixture"],
            check=True,
        )
        _, snapshot, workspace = self._stage_frozen_workspace(foreign_repo)
        self.assertEqual(snapshot["origin_repo_root"], str(foreign_repo))

        with self.assertRaisesRegex(SourceWorkspaceError, "different checkout"):
            validate_dependency_workspace(self.repo, self.layout, workspace)

    def test_frozen_snapshot_pin_rejects_incomplete_forged_and_redirected_metadata(self) -> None:
        stage, _, workspace = self._stage_frozen_workspace()
        manifest_path = Path(stage["manifest_path"])
        original = manifest_path.read_bytes()
        redirected_root = str(self.root / "redirected-frozen-source")
        cases = (
            ("missing snapshot pin", lambda data: data.pop("build_source_snapshot")),
            (
                "incomplete snapshot pin",
                lambda data: data["build_source_snapshot"].pop("source_root"),
            ),
            (
                "extra snapshot pin field",
                lambda data: data["build_source_snapshot"].update(extra="forged"),
            ),
            (
                "forged inventory hash",
                lambda data: data["build_source_snapshot"].update(
                    inventory_sha256="0" * 64
                ),
            ),
            (
                "redirected snapshot record",
                lambda data: data["build_source_snapshot"].update(
                    record_path=str(self.root / "redirected-record.json")
                ),
            ),
            (
                "redirected pin source root",
                lambda data: data["build_source_snapshot"].update(
                    source_root=redirected_root
                ),
            ),
            (
                "redirected manifest source root",
                lambda data: data.update(source_root=redirected_root),
            ),
            (
                "legacy selection with frozen pin",
                lambda data: data.update(
                    source_selection="filesystem-current-selected-inputs"
                ),
            ),
        )
        try:
            for label, mutate in cases:
                with self.subTest(case=label):
                    data = json.loads(original)
                    mutate(data)
                    manifest_path.write_text(json.dumps(data), encoding="utf-8")
                    with self.assertRaises(SourceWorkspaceError):
                        validate_dependency_workspace(self.repo, self.layout, workspace)
        finally:
            manifest_path.write_bytes(original)

    def test_tampered_frozen_snapshot_record_is_rejected(self) -> None:
        _, snapshot, workspace = self._stage_frozen_workspace()
        record_path = Path(snapshot["record_path"])
        original = record_path.read_bytes()
        record_path.chmod(0o644)
        try:
            data = json.loads(original)
            data["inventory_sha256"] = "0" * 64
            record_path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(SourceWorkspaceError):
                validate_dependency_workspace(self.repo, self.layout, workspace)
        finally:
            record_path.chmod(0o644)
            record_path.write_bytes(original)
            record_path.chmod(0o444)

    def test_missing_root_or_app_node_modules_is_rejected(self) -> None:
        for missing in (
            self.native_workspace / "node_modules",
            self.native_app / "node_modules",
        ):
            with self.subTest(path=missing):
                shutil.rmtree(missing)
                with self.assertRaises(SourceWorkspaceError):
                    validate_dependency_workspace(self.repo, self.layout, self.native_workspace)
                missing.mkdir()
                marker_name = "root-dependency.marker" if missing == self.native_workspace / "node_modules" else "app-dependency.marker"
                (missing / marker_name).write_text("restored", encoding="utf-8")

    def test_source_or_installed_dependency_input_drift_is_rejected(self) -> None:
        source_package = self.repo / "apps" / "control-room" / "package.json"
        original_source = source_package.read_bytes()
        source_package.write_bytes(original_source + b"\n")
        with self.assertRaises(SourceWorkspaceError):
            validate_dependency_workspace(self.repo, self.layout, self.native_workspace)

        source_package.write_bytes(original_source)

        installed_lock = self.native_workspace / "pnpm-lock.yaml"
        original_lock = installed_lock.read_bytes()
        installed_lock.write_bytes(original_lock + b"\n")
        with self.assertRaises(SourceWorkspaceError):
            validate_dependency_workspace(self.repo, self.layout, self.native_workspace)

    def test_patch_files_are_dependency_inputs(self) -> None:
        patch = self.repo / "patches" / "next.patch"
        patch.parent.mkdir()
        patch.write_text("patch input\n", encoding="utf-8")
        self.assertIn(patch, _dependency_input_paths(self.repo))

    def test_removed_source_patch_rejects_orphaned_installed_patch(self) -> None:
        source_patch = self.repo / "patches" / "next.patch"
        source_patch.parent.mkdir()
        source_patch.write_text("patch input\n", encoding="utf-8")
        installed_patch = self.native_workspace / "patches" / "next.patch"
        installed_patch.parent.mkdir()
        installed_patch.write_text("patch input\n", encoding="utf-8")
        source_patch.unlink()

        with self.assertRaisesRegex(SourceWorkspaceError, "patch inventory.*extra=patches/next.patch"):
            validate_dependency_workspace(self.repo, self.layout, self.native_workspace)

    def test_workspace_from_foreign_worktree_is_rejected(self) -> None:
        foreign_repo = self.root / "foreign-checkout"
        shutil.copytree(self.repo, foreign_repo, ignore=shutil.ignore_patterns(".git"))
        subprocess.run(["git", "-C", str(foreign_repo), "init", "--quiet"], check=True)
        subprocess.run(["git", "-C", str(foreign_repo), "config", "user.name", "Foreign fixture"], check=True)
        subprocess.run(["git", "-C", str(foreign_repo), "config", "user.email", "foreign@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(foreign_repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(foreign_repo), "commit", "--quiet", "-m", "Foreign fixture"], check=True)
        foreign_layout = fullmag_storage.resolve_layout(foreign_repo, PROFILE)
        foreign_build = Path(foreign_layout["build_root"])
        foreign_build.mkdir(parents=True)
        foreign_stage = stage_workspace_frontend.stage_workspace_frontend(
            foreign_repo, foreign_build, mode="dev", web_port=3197
        )
        foreign_workspace = Path(foreign_stage["workspace_root"])
        (foreign_workspace / "node_modules").mkdir()
        (foreign_workspace / "apps" / "control-room" / "node_modules").mkdir()

        with self.assertRaises(SourceWorkspaceError):
            validate_dependency_workspace(self.repo, self.layout, foreign_workspace)

    def test_foreign_source_root_in_manifest_is_rejected(self) -> None:
        manifest = Path(self.native_stage["manifest_path"])
        original = manifest.read_bytes()
        data = json.loads(original)
        data["source_root"] = str(self.root / "foreign-checkout")
        manifest.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(SourceWorkspaceError):
            validate_dependency_workspace(self.repo, self.layout, self.native_workspace)
        manifest.write_bytes(original)

    def test_escaped_workspace_is_rejected(self) -> None:
        outside = self.root / "outside-workspace"
        outside.mkdir()
        with self.assertRaises(SourceWorkspaceError):
            validate_dependency_workspace(self.repo, self.layout, outside)

    def test_run_root_must_be_owned_by_source_check_profile(self) -> None:
        outside_run = Path(self.layout["runs_root"]) / "api-hygiene" / "run-001"
        outside_run.mkdir(parents=True)
        with self.assertRaises(SourceWorkspaceError):
            prepare_source_workspace(self.repo, self.layout, outside_run, self.native_workspace)
        self.assertFalse((outside_run / "frontend-sources").exists())

    def test_arbitrary_layout_profile_is_rejected(self) -> None:
        invalid_layout = dict(self.layout)
        invalid_layout["profile"] = "some-other-profile"
        with self.assertRaises(SourceWorkspaceError):
            validate_dependency_workspace(self.repo, invalid_layout, self.native_workspace)

    def test_redirected_workspace_and_node_modules_are_rejected(self) -> None:
        workspace = self.native_workspace
        real_workspace = workspace.with_name("workspace-real")
        workspace.rename(real_workspace)
        stage_workspace_frontend._make_directory_link(workspace, real_workspace)
        with self.assertRaises(SourceWorkspaceError):
            validate_dependency_workspace(self.repo, self.layout, workspace)

        workspace.rmdir()
        real_workspace.rename(workspace)
        outside_node_modules = self.root / "redirected-node-modules"
        outside_node_modules.mkdir()
        root_modules = workspace / "node_modules"
        shutil.rmtree(root_modules)
        stage_workspace_frontend._make_directory_link(root_modules, outside_node_modules)
        with self.assertRaises(SourceWorkspaceError):
            validate_dependency_workspace(self.repo, self.layout, workspace)

    def test_invalid_schema_and_manifest_identity_are_rejected(self) -> None:
        manifest = Path(self.native_stage["manifest_path"])
        original = manifest.read_bytes()
        cases = (
            ("schema", "not-the-native-schema"),
            ("stage_id", "0" * 32),
            ("workspace_root", str(self.root / "redirected-workspace")),
            ("app_root", str(self.root / "redirected-app")),
            ("build_root", str(self.root / "redirected-build")),
        )
        for field, value in cases:
            with self.subTest(field=field):
                data = json.loads(original)
                data[field] = value
                manifest.write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaises(SourceWorkspaceError):
                    validate_dependency_workspace(self.repo, self.layout, self.native_workspace)
        manifest.write_bytes(original)

    def test_optional_npmrc_presence_must_match(self) -> None:
        installed_npmrc = self.native_workspace / ".npmrc"
        installed_npmrc.write_text("strict-peer-dependencies=false\n", encoding="utf-8")
        with self.assertRaises(SourceWorkspaceError):
            validate_dependency_workspace(self.repo, self.layout, self.native_workspace)


if __name__ == "__main__":
    unittest.main(verbosity=2)
