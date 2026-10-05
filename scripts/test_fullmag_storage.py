"""Behavioral regression checks for the project storage boundary (stdlib only)."""

import json
import os
from contextlib import contextmanager
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import fullmag_storage as storage


class StorageTests(unittest.TestCase):
    def setUp(self):
        isolated_env = {key: value for key, value in os.environ.items() if key not in storage.MANAGED_VARIABLES}
        environment = patch.dict(os.environ, isolated_env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # Windows runners may expose TEMP through an 8.3 short-name alias.
        # Author fixture paths canonically, as required by the storage guard.
        self.project = Path(self.temp.name).resolve() / "project"
        self.repo = self.project / "fullmag"
        self.repo.mkdir(parents=True)
        subprocess.run(["git", "init", "--quiet", str(self.repo)], check=True)
        self.env = {}

    def resolve(self, **kwargs):
        profile = kwargs.pop("profile", "test")
        return storage.resolve_layout(self.repo, profile=profile, environ=self.env, **kwargs)

    def test_storage_is_sibling_of_main_checkout_and_stable(self):
        layout = self.resolve()
        self.assertEqual(Path(layout["storage_root"]), self.project / "storage")
        self.assertEqual(layout, self.resolve())
        self.assertFalse((self.project / "storage").exists())

    def test_inventory_ignores_non_registration_json_arrays(self):
        layout = self.resolve()
        index = Path(layout["storage_root"]) / "index"
        index.mkdir(parents=True)
        (index / "metrics-history.json").write_text("[]", encoding="utf-8")
        result = storage.inventory(layout)
        self.assertEqual(result["records"], [])
        self.assertEqual(result["worktree_count"], 1)

    def test_dotenv_storage_root_and_process_precedence(self):
        custom = self.project / "configured-storage"
        custom.mkdir()
        (custom / ".fullmag-storage.json").write_text(json.dumps({
            "schema": storage.SCHEMA, "project_root": str(self.project)}))
        (self.repo / ".env").write_text(
            f'FULLMAG_PROJECT_STORAGE_ROOT="{custom}"\nUNRELATED_SECRET=ignored\n')
        self.assertEqual(Path(self.resolve()["storage_root"]), custom)
        self.assertNotIn("UNRELATED_SECRET", storage.storage_dotenv(self.repo))
        self.env["FULLMAG_PROJECT_STORAGE_ROOT"] = str(self.project / "storage")
        self.assertEqual(Path(self.resolve()["storage_root"]), self.project / "storage")

    def test_dotenv_invalid_path_is_not_silently_replaced(self):
        (self.repo / ".env").write_text("FULLMAG_PROJECT_STORAGE_ROOT=relative/path\n")
        with self.assertRaises(storage.StorageError):
            self.resolve()

    def test_nested_worktree_uses_common_project_and_isolated_build(self):
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Test", "-c",
                        "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], check=True)
        worktree = self.project / "worktrees" / "nested" / "task"
        subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "--quiet", "--detach", str(worktree)], check=True)
        main = self.resolve()
        other = storage.resolve_layout(worktree, profile="test", environ={})
        self.assertEqual(main["storage_root"], other["storage_root"])
        self.assertNotEqual(main["build_root"], other["build_root"])

    def test_worktree_reads_main_dotenv_without_local_copy(self):
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Test", "-c",
                        "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], check=True)
        worktree = self.project / "worktrees" / "task"
        subprocess.run(["git", "-C", str(self.repo), "worktree", "add", "--quiet", "--detach", str(worktree)], check=True)
        custom = self.project / "host-storage"
        custom.mkdir()
        (custom / ".fullmag-storage.json").write_text(json.dumps({
            "schema": storage.SCHEMA, "project_root": str(self.project)}))
        (self.repo / ".env").write_text(f'FULLMAG_PROJECT_STORAGE_ROOT="{custom}"\n')
        self.assertFalse((worktree / ".env").exists())
        layout = storage.resolve_layout(worktree, profile="test", environ={})
        self.assertEqual(Path(layout["storage_root"]), custom)
        self.assertNotEqual(layout["build_root"], self.resolve()["build_root"])

    def test_cargo_intermediate_override_cannot_escape_profile(self):
        self.env["CARGO_BUILD_BUILD_DIR"] = str(self.project / "outside")
        with self.assertRaises(storage.StorageError):
            self.resolve(profile="windows-native-fdm-cpu-dev")
        self.assertFalse((self.project / "storage").exists())

    def test_windows_intermediates_are_short_isolated_and_keep_final_target(self):
        for profile in storage.WINDOWS_WORKSPACE_STORAGE_PROFILES.values():
            layout = self.resolve(profile=profile)
            with self.subTest(profile=profile):
                self.assertEqual(Path(layout["env"]["CARGO_BUILD_BUILD_DIR"]), Path(layout["build_root"]) / "b")
                self.assertEqual(Path(layout["env"]["CARGO_TARGET_DIR"]), Path(layout["build_root"]) / "cargo-target")
        self.assertNotIn("CARGO_BUILD_BUILD_DIR", self.resolve()["env"])
        self.env["CARGO_BUILD_BUILD_DIR"] = str(Path(layout["build_root"]) / "custom")
        self.assertEqual(self.resolve(profile=profile)["env"]["CARGO_BUILD_BUILD_DIR"], self.env["CARGO_BUILD_BUILD_DIR"])

    def test_cargo_default_intermediates_reject_redirect_before_and_after_resolve(self):
        layout = self.resolve(profile="windows-native-fdm-cpu-dev")
        intermediate = Path(layout["env"]["CARGO_BUILD_BUILD_DIR"])
        outside = self.project / "outside"
        outside.mkdir()
        intermediate.parent.mkdir(parents=True)
        try:
            intermediate.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            if os.name != "nt":
                raise
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(intermediate), str(outside)], capture_output=True)
            if result.returncode:
                self.skipTest(f"Host cannot create a symlink/junction: {error}")
        with self.assertRaises(storage.StorageError):
            self.resolve(profile="windows-native-fdm-cpu-dev")
        with self.assertRaises(storage.StorageError):
            storage.initialize(layout)
        self.assertEqual(list(outside.iterdir()), [])

    def test_override_outside_storage_is_rejected_before_creation(self):
        self.env["CARGO_TARGET_DIR"] = str(self.project / "random-target")
        with self.assertRaises(storage.StorageError):
            self.resolve()
        self.assertFalse((self.project / "storage").exists())

    def test_windows_child_storage_overrides_are_rejected_before_creation(self):
        for variable in (
            "FULLMAG_WINDOWS_STATE_ROOT",
            "FULLMAG_WINDOWS_FRONTEND_ROOT",
            "FULLMAG_WINDOWS_NODE_MODULES_ROOT",
            "FULLMAG_WINDOWS_CONTROL_ROOM_NODE_MODULES_ROOT",
            "FULLMAG_WINDOWS_CARGO_HOME",
            "FULLMAG_WINDOWS_RUSTUP_HOME",
            "FULLMAG_WINDOWS_PNPM_ROOT",
        ):
            self.env[variable] = str(self.project / f"{variable.lower()}-outside")
            with self.subTest(variable=variable), self.assertRaises(storage.StorageError):
                self.resolve(profile="windows-fem-cpu")
            self.assertFalse((self.project / "storage").exists())
            self.env.pop(variable)

    def test_storage_must_not_be_checkout_or_drive_root(self):
        for path in (self.repo, self.project, Path(self.repo.anchor)):
            self.env["FULLMAG_PROJECT_STORAGE_ROOT"] = str(path)
            with self.subTest(path=path), self.assertRaises(storage.StorageError):
                self.resolve()

    def test_relative_override_rejected(self):
        self.env["FULLMAG_WINDOWS_BUILD_ROOT"] = "../build"
        with self.assertRaises(storage.StorageError):
            self.resolve()

    def test_arbitrary_storage_root_cannot_initialize_itself(self):
        alternate = self.project.parent / "random-storage"
        self.env["FULLMAG_PROJECT_STORAGE_ROOT"] = str(alternate)
        with self.assertRaises(storage.StorageError):
            self.resolve()
        self.assertFalse(alternate.exists())

    def test_profile_cannot_escape(self):
        with self.assertRaises(storage.StorageError):
            storage.resolve_layout(self.repo, profile="../elsewhere", environ={})

    def test_marker_and_foreign_marker(self):
        layout = self.resolve()
        storage.initialize(layout)
        storage.initialize(layout)
        self.assertTrue(Path(layout["frontend_root"]).is_dir())
        marker = Path(layout["storage_root"]) / ".fullmag-storage.json"
        data = json.loads(marker.read_text())
        data["project_root"] = str(self.project / "another")
        marker.write_text(json.dumps(data))
        with self.assertRaises(storage.StorageError):
            storage.initialize(layout)

    def test_same_build_lock_rejects_concurrent_writer(self):
        layout = self.resolve()
        storage.initialize(layout)
        with storage.build_lock(layout):
            command = [sys.executable, "-B", str(Path(storage.__file__)), "run",
                       "--repo-root", str(self.repo), "--profile", "test", "--",
                       sys.executable, "-c", "raise SystemExit(93)"]
            env = {key: value for key, value in os.environ.items()
                   if key not in storage.MANAGED_VARIABLES}
            result = subprocess.run(command, capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("busy", result.stderr.lower())

    def test_child_failure_is_recorded_and_releases_lock(self):
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Test", "-c",
                        "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], check=True)
        layout = self.resolve()
        result = storage.run(layout, [sys.executable, "-c", "raise SystemExit(7)"])
        self.assertEqual(result, 7)
        record = json.loads((Path(layout["build_root"]) / "build-status.json").read_text())
        self.assertEqual(record["state"], "failed")
        self.assertEqual(record["exit_code"], 7)
        with storage.build_lock(layout):
            pass

    def test_windows_workspace_uses_runtime_lane_while_generic_run_keeps_heavy_guard(self):
        layout = self.resolve(profile="windows-native-fdm-cpu")
        storage.initialize(layout)
        storage.prepare_links(layout, compat=True)
        launcher = self.repo / "scripts" / "windows" / "run_fullmag.ps1"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("# workspace fixture\n", encoding="utf-8")
        runner_marker = Path(layout["storage_root"]) / "index" / "local-runner-container.json"
        runner_marker.write_text(json.dumps({"container_id": "fixture"}), encoding="utf-8")

        with self.assertRaises(storage.StorageError):
            storage.run(layout, [sys.executable, "-c", "raise SystemExit(99)"])

        @contextmanager
        def unlocked(*_args, **_kwargs):
            yield

        calls = []

        def fake_git(_repo, *args):
            if args == ("rev-parse", "HEAD"):
                return "0" * 40
            if args == ("status", "--porcelain", "--untracked-files=normal"):
                return ""
            raise AssertionError(args)

        def fake_run(command, **_kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0)

        def fake_runtime(runtime_layout, command, env, profile):
            self.assertEqual(profile, "release")
            self.assertEqual(runtime_layout["runtime_root"], layout["runtime_root"])
            calls.append(command)
            storage.atomic_json(Path(layout["runtime_root"]) / "native-workspace-status.json", {
                "schema": storage.SCHEMA, "execution_mode": "windows-workspace",
                "worktree_id": layout["worktree_id"], "repo_root": layout["repo_root"],
                "state": "completed", "manager_pid": os.getpid(), "launcher_pid": 12,
                "launcher_waited": True, "watcher_waited": True,
                "exit_code": 0, "finished_at": storage.now(),
            })
            return 0

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", unlocked), \
             patch.object(storage, "git", side_effect=fake_git), \
             patch.object(storage.subprocess, "run", side_effect=fake_run), \
             patch("windows.runtime_lease.run_sealed_runtime", side_effect=fake_runtime):
            result = storage.run_windows_workspace(layout, "static", 3197, build_mode="false")

        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0:6], [
            "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass",
        ])
        self.assertEqual(calls[0][calls[0].index("-RunMode") + 1], "workspace")
        self.assertEqual(calls[0][calls[0].index("-WebPort") + 1], "3197")
        self.assertEqual(calls[0][calls[0].index("-BackendProfile") + 1], "release")
        receipt = json.loads((Path(layout["runtime_root"]) / "native-workspace-status.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["execution_mode"], "windows-workspace")

        calls.clear()
        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", unlocked), \
             patch.object(storage, "git", side_effect=fake_git), \
             patch.object(storage.subprocess, "run", side_effect=fake_run), \
             patch("windows.runtime_lease.run_sealed_runtime", side_effect=fake_runtime):
            result = storage.run_windows_workspace(layout, "static", 3197, build_mode="auto")

        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 2)
        self.assertIn("-BuildOnly", calls[0])
        self.assertEqual(calls[0][calls[0].index("-BuildMode") + 1], "auto")
        self.assertEqual(calls[0][calls[0].index("-BackendProfile") + 1], "release")
        self.assertNotIn("-BuildOnly", calls[1])
        self.assertEqual(calls[1][calls[1].index("-BuildMode") + 1], "false")
        self.assertEqual(calls[1][calls[1].index("-RunMode") + 1], "workspace")

    def test_workspace_auto_profile_and_canonical_storage_are_separate(self):
        self.assertEqual(storage.resolve_windows_workspace_backend_profile("dev", "auto"), "dev")
        self.assertEqual(storage.resolve_windows_workspace_backend_profile("static", "auto"), "release")
        self.assertEqual(storage.resolve_windows_workspace_backend_profile("dev", "release"), "release")
        with self.assertRaises(storage.StorageError):
            storage.resolve_windows_workspace_backend_profile("invalid", "auto")
        with self.assertRaises(storage.StorageError):
            storage.resolve_windows_workspace_backend_profile("dev", "custom")

        release = self.resolve(profile="windows-native-fdm-cpu")
        dev = self.resolve(profile="windows-native-fdm-cpu-dev")
        self.assertNotEqual(release["build_root"], dev["build_root"])
        self.assertNotEqual(release["env"]["CARGO_TARGET_DIR"], dev["env"]["CARGO_TARGET_DIR"])
        self.assertTrue(release["build_root"].endswith("windows-native-fdm-cpu"))
        self.assertTrue(dev["build_root"].endswith("windows-native-fdm-cpu-dev"))

    def test_workspace_build_only_uses_closed_profile_lock_and_terminal_receipt(self):
        layout = self.resolve(profile="windows-native-fdm-cpu-dev")
        launcher = self.repo / "scripts" / "windows" / "run_fullmag.ps1"
        launcher.parent.mkdir(parents=True)
        launcher.write_text("# workspace fixture\n", encoding="utf-8")

        @contextmanager
        def unlocked(*_args, **_kwargs):
            yield

        calls = []

        def fake_git(_repo, *args):
            if args == ("rev-parse", "HEAD"):
                return "0" * 40
            if args == ("status", "--porcelain", "--untracked-files=normal"):
                return ""
            raise AssertionError(args)

        def fake_run(command, **_kwargs):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0)

        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "file_lock", unlocked), \
             patch.object(storage, "git", side_effect=fake_git), \
             patch.object(storage.subprocess, "run", side_effect=fake_run):
            result = storage.run_windows_workspace_build(
                layout, "dev", 3197, "dev", build_mode="auto"
            )

        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        self.assertIn("-BuildOnly", calls[0])
        self.assertEqual(calls[0][calls[0].index("-BuildMode") + 1], "auto")
        self.assertEqual(calls[0][calls[0].index("-BackendProfile") + 1], "dev")
        self.assertNotIn("-RunMode", calls[0][calls[0].index("-BuildOnly") + 1:])
        receipt = json.loads((Path(layout["build_root"]) / "build-status.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["execution_mode"], "windows-workspace-build")
        self.assertEqual(receipt["profile"], "windows-native-fdm-cpu-dev")
        self.assertEqual(receipt["state"], "completed")

    def test_workspace_build_admission_rejects_wrong_profile_and_generic_bypass_before_write(self):
        release = self.resolve(profile="windows-native-fdm-cpu")
        with patch.object(storage, "_is_native_windows", return_value=True):
            with self.assertRaises(storage.StorageError):
                storage.run_windows_workspace_build(release, "dev", 3197, "dev")
            with self.assertRaises(storage.StorageError):
                storage._run_managed_command(
                    release,
                    ["arbitrary-command"],
                    native_user_build=True,
                    workspace_backend_profile="release",
                    execution_mode="windows-workspace-build",
                )
        self.assertFalse(Path(release["storage_root"]).exists())

    def test_initialize_rechecks_redirected_build_path(self):
        layout = self.resolve()
        outside = self.project / "outside"
        outside.mkdir()
        build = Path(layout["build_root"])
        build.parent.mkdir(parents=True)
        try:
            build.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            if os.name != "nt":
                raise
            # Junctions exercise the actual Windows escape even without the
            # developer-mode privilege required for symbolic links.
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(build), str(outside)], capture_output=True)
            if result.returncode:
                self.skipTest(f"Host cannot create a symlink/junction: {error}")
        with self.assertRaises(storage.StorageError):
            storage.initialize(layout)
        self.assertEqual(list(outside.iterdir()), [])

    def test_nested_managed_command_inherits_live_lock(self):
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Test", "-c",
                        "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"], check=True)
        layout = self.resolve()
        storage.initialize(layout)
        with storage.build_lock(layout):
            command = [sys.executable, "-B", str(Path(storage.__file__)), "run",
                       "--repo-root", str(self.repo), "--profile", "test", "--",
                       sys.executable, "-c", "raise SystemExit(0)"]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_frontend_links_preserve_pnpm_layout_and_refuse_existing_data(self):
        app = self.repo / "apps/control-room"
        app.mkdir(parents=True)
        existing = app / "out"
        existing.mkdir()
        (existing / "result.txt").write_text("keep")
        layout = self.resolve()
        with self.assertRaises(storage.StorageError):
            storage.prepare_links(layout, frontend=True)
        self.assertFalse((self.project / "storage").exists())
        self.assertEqual((existing / "result.txt").read_text(), "keep")

    def test_prepare_compat_is_idempotent_and_does_not_change_link(self):
        layout = self.resolve()
        storage.prepare_links(layout, compat=True)
        storage.prepare_links(layout, compat=True)
        self.assertTrue(storage.is_link(self.repo / ".fullmag"))
        self.assertEqual((self.repo / ".fullmag").resolve(), Path(layout["runtime_root"]))

    def test_prepare_compat_rebinds_indexed_target_when_switching_profiles(self):
        cpu = self.resolve(profile="windows-native-fdm-cpu")
        gpu = self.resolve(profile="windows-native-fdm-gpu")

        storage.prepare_links(cpu, compat=True)
        target = self.repo / "target"
        cpu_target = target.resolve()
        self.assertEqual(cpu_target, Path(cpu["env"]["CARGO_TARGET_DIR"]))

        storage.prepare_links(gpu, compat=True)
        self.assertTrue(storage.is_link(target))
        self.assertEqual(target.resolve(), Path(gpu["env"]["CARGO_TARGET_DIR"]))
        self.assertNotEqual(cpu_target, target.resolve())

    def test_prepare_compat_requires_indexed_target_for_rebind(self):
        cpu = self.resolve(profile="windows-native-fdm-cpu")
        gpu = self.resolve(profile="windows-native-fdm-gpu")
        storage.prepare_links(cpu, compat=True)
        target = self.repo / "target"
        cpu_target = target.resolve()
        registry = Path(cpu["storage_root"]) / "index" / f"{cpu['worktree_id']}.links.json"
        registry.unlink()

        with self.assertRaises(storage.StorageError):
            storage.prepare_links(gpu, compat=True)
        self.assertTrue(storage.is_link(target))
        self.assertEqual(target.resolve(), cpu_target)

    def test_run_refuses_stale_profile_link_before_command(self):
        cpu = self.resolve(profile="windows-native-fdm-cpu")
        gpu = self.resolve(profile="windows-native-fdm-gpu")
        storage.prepare_links(cpu, compat=True)
        marker = self.project / "command-ran.txt"

        with self.assertRaises(storage.StorageError):
            storage.run(
                gpu,
                [
                    sys.executable,
                    "-c",
                    f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
                ],
            )
        self.assertFalse(marker.exists())

    def test_run_refuses_foreign_build_status_before_command(self):
        layout = self.resolve(profile="windows-native-fdm-cpu")
        storage.initialize(layout)
        status = Path(layout["build_root"]) / "build-status.json"
        foreign = {
            "schema": storage.SCHEMA,
            "worktree_id": "another-worktree",
            "profile": layout["profile"],
            "repo_root": layout["repo_root"],
            "state": "completed",
        }
        status.write_text(json.dumps(foreign), encoding="utf-8")
        marker = self.project / "command-ran.txt"

        with self.assertRaises(storage.StorageError):
            storage.run(
                layout,
                [
                    sys.executable,
                    "-c",
                    f"from pathlib import Path; Path({str(marker)!r}).write_text('ran')",
                ],
            )
        self.assertFalse(marker.exists())
        self.assertEqual(json.loads(status.read_text(encoding="utf-8")), foreign)

    def test_export_removes_external_child_not_parent_link(self):
        (self.repo / "apps/control-room").mkdir(parents=True)
        layout = self.resolve()
        storage.prepare_links(layout, frontend=True)
        app = self.repo / "apps/control-room"
        # Next exports by recursively removing outdir first. A parent link
        # survives that operation, unlike making outdir itself the only link.
        export = app / ".fullmag-frontend/out"
        (export / "old.html").write_text("old")
        shutil.rmtree(export)
        export.mkdir()
        (export / "index.html").write_text("new")
        self.assertTrue(storage.is_link(app / ".fullmag-frontend"))
        self.assertTrue(storage.is_link(app / "out"))
        self.assertEqual((Path(layout["frontend_root"]) / "out/index.html").read_text(), "new")

    def test_assert_lock_cannot_be_enabled_with_only_entry_sentinel(self):
        result = subprocess.run([sys.executable, "-B", str(Path(storage.__file__)), "assert-lock",
                                 "--repo-root", str(self.repo)], capture_output=True, text=True,
                                env={**os.environ, "FULLMAG_STORAGE_MANAGED_ENTRY": "1"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("No inherited managed lock", result.stderr)

    def test_uncertain_native_owner_blocks_before_storage_initialization(self):
        layout = self.resolve(profile="windows-native-fdm-cpu-dev")
        with patch.object(storage, "_is_native_windows", return_value=True), \
             patch.object(storage, "initialize", side_effect=AssertionError("Must not write")), \
             patch("windows.runtime_lease.active_runtime", side_effect=storage.StorageError("uncertain owner")):
            with self.assertRaisesRegex(storage.StorageError, "uncertain owner"):
                storage._run_managed_command(
                    layout, ["fixed-launcher"], native_user_build=True,
                    native_workspace_paths=True, workspace_backend_profile="dev",
                    execution_mode="windows-workspace-build",
                )

    def test_independent_service_blocks_native_start_and_build_before_initialization(self):
        layout = self.resolve(profile="windows-native-fdm-cpu-dev")
        owner = Path(layout["runs_root"]) / "session-store" / "runtime-services" / "OWNER.json"
        owner.parent.mkdir(parents=True)
        owner.write_text('{"state":"ready"}', encoding="utf-8")
        for mode in ("windows-workspace", "windows-workspace-build"):
            with self.subTest(mode=mode), \
                 patch.object(storage, "_is_native_windows", return_value=True), \
                 patch.object(storage, "initialize", side_effect=AssertionError("Must not write")), \
                 patch("windows.runtime_lease.active_runtime", return_value=None), \
                 patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(storage.StorageError, "owner/launch state is present"):
                    storage._run_managed_command(
                        layout, ["fixed-launcher"],
                        native_user_build=mode == "windows-workspace-build",
                        native_workspace_paths=True, workspace_backend_profile="dev",
                        execution_mode=mode,
                    )
        self.assertEqual(owner.read_text(encoding="utf-8"), '{"state":"ready"}')

    @unittest.skipIf(os.name == "nt", "Linux mount contract")
    def test_cifs_selects_managed_ext4_and_unmounted_view_fails(self):
        with patch.object(storage, "filesystem_type", return_value="cifs"):
            layout = self.resolve()
        self.assertTrue(layout["managed_ext4"])
        self.assertTrue(layout["build_root"].startswith("/mnt/fullmag-zfn2-native/storage/"))
        failed = subprocess.CompletedProcess([], 1, "", "unmounted")
        with patch.object(storage.subprocess, "run", return_value=failed), self.assertRaises(storage.StorageError):
            storage.initialize(layout)
        self.assertFalse((self.project / "storage").exists())

    @unittest.skipIf(os.name == "nt", "Linux mount contract")
    def test_wrong_ext4_image_is_rejected(self):
        with patch.object(storage, "filesystem_type", return_value="cifs"):
            layout = self.resolve()
        found = subprocess.CompletedProcess([], 0, "ext4 /dev/loop7\n", "")
        with patch.object(storage.subprocess, "run", return_value=found), \
             patch.object(Path, "read_text", return_value="/wrong/image.ext4\n"), \
             self.assertRaises(storage.StorageError):
            storage.validate_managed_view(layout)


if __name__ == "__main__":
    unittest.main()
