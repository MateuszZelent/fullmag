"""Interpreted regression checks for native dependency workspace reuse."""

from __future__ import annotations

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
    prepare_source_workspace,
    validate_dependency_workspace,
)


PROFILE = fullmag_storage.WINDOWS_WORKSPACE_STORAGE_PROFILES["dev"]
SOURCE_PROFILE = "windows-control-room-source-check"


class FrontendSourceWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(
            prefix=".test-frontend-source-workspace-", dir=SCRIPT_ROOT.parent
        )
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.repo = self.root / "checkout"
        self.repo.mkdir()
        self.storage_root = self.root / "storage"
        self._previous_storage = os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT")
        os.environ["FULLMAG_PROJECT_STORAGE_ROOT"] = str(self.storage_root)
        self.addCleanup(self._restore_storage_environment)

        self._write_source_fixture()
        self._git("init", "--quiet")
        self._git("config", "user.name", "Frontend source workspace tests")
        self._git("config", "user.email", "frontend-source-workspace@example.invalid")
        self._git("add", "-A")
        self._git("commit", "--quiet", "-m", "Create frontend source fixture")

        self.layout = fullmag_storage.resolve_layout(self.repo, SOURCE_PROFILE)
        self.run_root = Path(self.layout["build_root"]) / "api-hygiene" / "run-001"
        self.run_root.mkdir(parents=True)
        self.native_layout = fullmag_storage.resolve_layout(self.repo, PROFILE)
        build_root = Path(self.native_layout["build_root"])
        build_root.mkdir(parents=True)
        self.native_stage = stage_workspace_frontend.stage_workspace_frontend(
            self.repo,
            build_root,
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
        if self._previous_storage is None:
            os.environ.pop("FULLMAG_PROJECT_STORAGE_ROOT", None)
        else:
            os.environ["FULLMAG_PROJECT_STORAGE_ROOT"] = self._previous_storage

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
