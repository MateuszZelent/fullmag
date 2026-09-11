"""Unit tests for the trusted container Fullmag build entrypoint."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from local_runner import build_entrypoint as entrypoint


class BuildEntryPointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="fullmag-build-entrypoint-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.workspace = self.root / "workspace"
        self.build = self.root / "build"
        self.artifacts = self.root / "artifacts"
        for path in (self.source, self.workspace, self.build, self.artifacts):
            path.mkdir()
        (self.workspace / ".fullmag-build").mkdir()
        (self.workspace / ".fullmag-cargo").mkdir()
        (self.workspace / ".fullmag-rustup").mkdir()
        self.job_id = "job-123"
        self.profile = "fem-cpu-release"
        self.image_digest = "sha256:" + "f" * 64
        self.manifest, self.source_digest = self._make_capsule()

    def _make_capsule(self) -> tuple[dict[str, object], str]:
        tree = self.source / "tree"
        tree.mkdir()
        source_file = tree / "README.txt"
        source_file.write_text("immutable source\n", encoding="utf-8")
        source_file.chmod(0o755)
        file_bytes = source_file.read_bytes()
        manifest: dict[str, object] = {
            "schema_version": entrypoint.CAPSULE_SCHEMA,
            "source_mode": "commit",
            "resolved_commit": "a" * 40,
            "files": [
                {
                    "path": "README.txt",
                    "type": "file",
                    "mode": "100755",
                    "size": len(file_bytes),
                    "sha256": hashlib.sha256(file_bytes).hexdigest(),
                }
            ],
            "deleted": [],
            "included_untracked": [],
            "excluded": [],
        }
        manifest["source_digest"] = hashlib.sha256(
            entrypoint.canonical(manifest)
        ).hexdigest()
        (self.source / "manifest.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )
        return manifest, str(manifest["source_digest"])

    def _identity(self) -> dict[str, object]:
        identity: dict[str, object] = {
            "schema": entrypoint.IDENTITY_SCHEMA,
            "head_commit_full": "a" * 40,
            "head_tree_sha256": "1" * 64,
            "git_status_porcelain_v1": [],
            "dirty_path_content": [],
            "dirty_content_sha256": "2" * 64,
            "source_snapshot_dirty": False,
        }
        payload = dict(identity)
        for derived in ("source_snapshot_dirty", "dirty_content_sha256"):
            payload.pop(derived, None)
        identity["source_snapshot_sha256"] = hashlib.sha256(
            entrypoint.canonical(payload)
        ).hexdigest()
        return identity

    def _write_context(self, *, include_identity: bool = True) -> Path:
        context: dict[str, object] = {
            "schema": entrypoint.CONTEXT_SCHEMA,
            "job_id": self.job_id,
            "source_digest": self.source_digest,
            "profile": self.profile,
            "image_digest": self.image_digest,
        }
        if include_identity:
            context["native_source_identity"] = self._identity()
        path = self.root / "context.json"
        path.write_text(json.dumps(context), encoding="utf-8")
        return path

    def _argv(self, context: Path) -> list[str]:
        return [
            "--job-id",
            self.job_id,
            "--source-digest",
            self.source_digest,
            "--profile",
            self.profile,
            "--source",
            str(self.source),
            "--workspace",
            str(self.workspace),
            "--build",
            str(self.build),
            "--artifacts",
            str(self.artifacts),
            "--context",
            str(context),
            "--jobs",
            "2",
        ]

    def _write_outputs(self, marker: str = "fem-cpu") -> Path:
        output = self.workspace / ".fullmag" / "local"
        (output / "bin").mkdir(parents=True)
        (output / "lib").mkdir()
        (output / "web").mkdir()
        (output / "bin" / "fullmag-bin").write_bytes(b"cli")
        (output / "bin" / "fullmag-api").write_bytes(b"api")
        (output / "_fullmag_core.so").write_bytes(b"core")
        (output / "launcher-build-mode").write_text(marker + "\n", encoding="utf-8")
        (output / "web" / "index.html").write_text("<html />", encoding="utf-8")
        return output

    def test_profile_environment_cannot_silently_fallback(self) -> None:
        identity = self._identity()
        cpu = entrypoint.build_environment(
            entrypoint.profile_for("fem-cpu-release"),
            workspace=self.workspace,
            build=self.build,
            jobs=2,
            native_identity=identity,
        )
        self.assertEqual(cpu["FULLMAG_FORCE_LOCAL_FEM_CPU"], "1")
        self.assertEqual(cpu["FULLMAG_FORCE_LOCAL_FEM_GPU"], "0")
        self.assertEqual(cpu["FULLMAG_BUILD_CPU_ONLY"], "0")
        self.assertEqual(cpu["FULLMAG_FEM_WITH_SLEPC"], "OFF")
        self.assertEqual(cpu["CARGO_BUILD_JOBS"], "2")
        self.assertEqual(
            cpu["FULLMAG_SOURCE_SNAPSHOT_SHA256"],
            identity["source_snapshot_sha256"],
        )
        self.assertEqual(cpu["HOME"], "/workspace/.fullmag-build/home")
        self.assertEqual(cpu["TMPDIR"], "/workspace/.fullmag-build/tmp")
        self.assertTrue((self.build / "home").is_dir())
        self.assertTrue((self.build / "tmp").is_dir())
        gpu = entrypoint.profile_for("fem-gpu-release")
        self.assertTrue(gpu.needs_cuda_toolchain)
        self.assertEqual(gpu.environment["FULLMAG_FORCE_LOCAL_FEM_GPU"], "1")
        fdm = entrypoint.profile_for("fdm-cpu-release")
        self.assertEqual(fdm.environment["FULLMAG_BUILD_CPU_ONLY"], "1")

    def test_preflight_requires_an_installed_nightly_toolchain(self) -> None:
        with patch.object(
            entrypoint.shutil,
            "which",
            side_effect=lambda name: f"/usr/bin/{name}",
        ), patch.object(
            entrypoint.subprocess,
            "run",
            return_value=entrypoint.subprocess.CompletedProcess(
                ["rustup", "toolchain", "list"], 0, "stable-x86_64-unknown-linux-gnu\n", ""
            ),
        ):
            with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "nightly"):
                entrypoint.preflight(entrypoint.profile_for("fdm-cpu-release"), release=False)
        # A fresh host gets an operator-actionable remedy, but the trusted
        # runner must not turn a build into an implicit network/bootstrap step.
        with patch.object(
            entrypoint.shutil,
            "which",
            side_effect=lambda name: f"/usr/bin/{name}",
        ), patch.object(
            entrypoint.subprocess,
            "run",
            return_value=entrypoint.subprocess.CompletedProcess(
                ["rustup", "toolchain", "list"], 0, "stable-x86_64-unknown-linux-gnu\n", ""
            ),
        ):
            with self.assertRaisesRegex(
                entrypoint.BuildEntryPointError,
                r"rustup toolchain install nightly.*never downloads",
            ):
                entrypoint.preflight(entrypoint.profile_for("fdm-cpu-release"), release=False)

    def test_context_keeps_capsule_digest_separate_from_native_v2_identity(self) -> None:
        context_path = self._write_context()
        context = entrypoint.load_context(
            context_path,
            job_id=self.job_id,
            source_digest=self.source_digest,
            profile=self.profile,
        )
        self.assertEqual(
            context["native_source_identity"]["source_snapshot_sha256"],
            self._identity()["source_snapshot_sha256"],
        )

    def test_context_rejects_tampered_native_v2_self_hash(self) -> None:
        context_path = self._write_context()
        context = json.loads(context_path.read_text(encoding="utf-8"))
        context["native_source_identity"]["head_tree_sha256"] = "4" * 64
        context_path.write_text(json.dumps(context), encoding="utf-8")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "does not match"):
            entrypoint.load_context(
                context_path,
                job_id=self.job_id,
                source_digest=self.source_digest,
                profile=self.profile,
            )

    def test_materialization_preserves_mode_and_does_not_create_git(self) -> None:
        manifest = entrypoint.verify_source(self.source, self.source_digest)
        entrypoint.materialize_capsule(manifest, self.source, self.workspace)
        source_mode = stat.S_IMODE((self.source / "tree" / "README.txt").stat().st_mode)
        target_mode = stat.S_IMODE((self.workspace / "README.txt").stat().st_mode)
        if entrypoint.os.name != "nt":
            self.assertEqual(target_mode, 0o755)
        self.assertEqual((self.workspace / "README.txt").read_text(encoding="utf-8"), "immutable source\n")
        self.assertFalse((self.workspace / ".git").exists())

    def test_materialization_makes_private_dirs_writable_without_changing_capsule(self) -> None:
        nested = self.source / "tree" / "readonly" / "nested"
        nested.mkdir(parents=True)
        nested_file = nested / "input.txt"
        nested_file.write_text("nested immutable input\n", encoding="utf-8")
        if entrypoint.os.name != "nt":
            (self.source / "tree" / "readonly").chmod(0o555)
            nested.chmod(0o555)
        nested_bytes = nested_file.read_bytes()
        files = list(self.manifest["files"])
        files.append(
            {
                "path": "readonly/nested/input.txt",
                "type": "file",
                "mode": "100644",
                "size": len(nested_bytes),
                "sha256": hashlib.sha256(nested_bytes).hexdigest(),
            }
        )
        manifest = {**self.manifest, "files": files}
        source_modes = {
            path: stat.S_IMODE(path.stat().st_mode)
            for path in (self.source / "tree" / "readonly", nested, nested_file)
        }
        mount_modes = {
            path: stat.S_IMODE(path.stat().st_mode)
            for path in (
                self.workspace / ".fullmag-build",
                self.workspace / ".fullmag-cargo",
                self.workspace / ".fullmag-rustup",
            )
        }
        if entrypoint.os.name != "nt":
            self.workspace.chmod(0o555)

        entrypoint.materialize_capsule(manifest, self.source, self.workspace)

        copied_root = self.workspace / "readonly"
        copied_nested = copied_root / "nested"
        if entrypoint.os.name != "nt":
            self.assertTrue(stat.S_IMODE(copied_root.stat().st_mode) & stat.S_IWUSR)
            self.assertTrue(stat.S_IMODE(copied_nested.stat().st_mode) & stat.S_IWUSR)
            self.assertTrue(
                stat.S_IMODE(self.workspace.stat().st_mode) & stat.S_IWUSR,
                "private workspace root must be owner-writable",
            )
            for path, mode in source_modes.items():
                self.assertEqual(mode, stat.S_IMODE(path.stat().st_mode))
            for path, mode in mount_modes.items():
                self.assertEqual(mode, stat.S_IMODE(path.stat().st_mode))
        self.assertEqual(nested_bytes, (copied_nested / "input.txt").read_bytes())

    def test_tail_text_reads_only_a_bounded_suffix(self) -> None:
        log = self.root / "large.log"
        log.write_text("a" * 10000 + "TAIL", encoding="utf-8")
        suffix = entrypoint._tail_text(log)
        self.assertEqual(len(suffix), 1024)
        self.assertTrue(suffix.endswith("TAIL"))

    def test_runtime_outputs_dereference_internal_library_links_only(self) -> None:
        output = self._write_outputs()
        library = output / "lib" / "libfullmag.so.1.0"
        library.write_bytes(b"library")
        try:
            (output / "lib" / "libfullmag.so.1").symlink_to(library.name)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symlinks unavailable: {error}")
        destination_root = self.artifacts / "outputs" / ".fullmag" / "local"
        entrypoint._copy_outputs(self.workspace, self.artifacts)
        copied_link = destination_root / "lib" / "libfullmag.so.1"
        self.assertTrue(copied_link.is_file())
        self.assertFalse(copied_link.is_symlink())
        self.assertEqual(copied_link.read_bytes(), b"library")
        self.assertFalse((destination_root / "cache").exists())

    def test_runtime_outputs_reject_symlink_into_venv(self) -> None:
        output = self._write_outputs()
        venv = output / ".venv"
        venv.mkdir()
        (venv / "secret").write_bytes(b"secret")
        try:
            (output / "lib" / "secret.so").symlink_to(Path("..") / ".venv" / "secret")
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symlinks unavailable: {error}")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "escapes output"):
            entrypoint._copy_outputs(self.workspace, self.artifacts)

    def test_workspace_allows_only_persistent_mountpoints(self) -> None:
        (self.workspace / ".fullmag-cargo" / "registry-cache").write_text("cache")
        entrypoint._workspace_is_empty(self.workspace)
        (self.workspace / "unexpected.txt").write_text("not a mount")
        with self.assertRaisesRegex(entrypoint.BuildEntryPointError, "workspace must be empty"):
            entrypoint._workspace_is_empty(self.workspace)

    def test_missing_native_identity_fails_and_publishes_receipt(self) -> None:
        context = self._write_context(include_identity=False)
        code = entrypoint.main(self._argv(context))
        self.assertEqual(code, 2)
        receipt = json.loads((self.artifacts / "build-receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(receipt["qualification"], "NOT VERIFIED")
        self.assertIn("native_source_identity", receipt["error"])

    def test_success_runs_only_managed_fixed_stages_and_publishes_receipt(self) -> None:
        context = self._write_context()
        calls: list[tuple[str, list[str]]] = []

        def fake_stage(name, command, *, workspace, artifacts, environment):
            calls.append((name, command))
            if name == "native-build":
                self._write_outputs()
            logs = artifacts / "logs"
            logs.mkdir(exist_ok=True)
            (logs / f"{name}.stdout.log").write_text("ok\n", encoding="utf-8")
            (logs / f"{name}.stderr.log").write_text("", encoding="utf-8")
            return {
                "name": name,
                "command": command,
                "started_at": "now",
                "finished_at": "now",
                "duration_ms": 1,
                "exit_code": 0,
                "stdout_log": f"logs/{name}.stdout.log",
                "stderr_log": f"logs/{name}.stderr.log",
                "stdout_tail": "ok",
                "stderr_tail": "",
            }

        with patch.object(
            entrypoint,
            "preflight",
            return_value={"make": "/usr/bin/make", "pnpm": "/usr/bin/pnpm"},
        ), patch.object(entrypoint, "toolchain_versions", return_value={"make": {}}), patch.object(
            entrypoint, "run_stage", side_effect=fake_stage
        ):
            code = entrypoint.main(self._argv(context))

        self.assertEqual(code, 0)
        self.assertEqual(
            calls,
            [
                ("native-build", ["/usr/bin/make", "install-cli-dev"]),
                (
                    "frontend-dependencies",
                    ["/usr/bin/pnpm", "install", "--dir", "apps/control-room", "--frozen-lockfile"],
                ),
                ("frontend-build", ["/usr/bin/make", "web-build-static"]),
            ],
        )
        receipt = json.loads((self.artifacts / "build-receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "succeeded")
        self.assertEqual(receipt["source_digest"], self.source_digest)
        self.assertEqual(receipt["source_digest_kind"], "capsule")
        self.assertEqual(
            receipt["native_source_identity"]["source_snapshot_sha256"],
            self._identity()["source_snapshot_sha256"],
        )
        self.assertEqual(receipt["qualification"], "NOT VERIFIED")
        self.assertNotIn(".git", {path.name for path in self.workspace.iterdir()})

    def test_successful_commands_without_required_outputs_fail_receipt(self) -> None:
        context = self._write_context()

        def fake_stage(name, command, *, workspace, artifacts, environment):
            logs = artifacts / "logs"
            logs.mkdir(exist_ok=True)
            (logs / f"{name}.stdout.log").write_text("ok\n", encoding="utf-8")
            (logs / f"{name}.stderr.log").write_text("", encoding="utf-8")
            return {
                "name": name,
                "command": command,
                "started_at": "now",
                "finished_at": "now",
                "duration_ms": 1,
                "exit_code": 0,
                "stdout_log": f"logs/{name}.stdout.log",
                "stderr_log": f"logs/{name}.stderr.log",
                "stdout_tail": "ok",
                "stderr_tail": "",
            }

        with patch.object(
            entrypoint,
            "preflight",
            return_value={"make": "/usr/bin/make", "pnpm": "/usr/bin/pnpm"},
        ), patch.object(entrypoint, "toolchain_versions", return_value={}), patch.object(
            entrypoint, "run_stage", side_effect=fake_stage
        ):
            code = entrypoint.main(self._argv(context))

        self.assertEqual(code, 2)
        receipt = json.loads((self.artifacts / "build-receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "failed")
        self.assertIn("required Fullmag output is missing", receipt["error"])

    def test_failed_stage_keeps_failed_receipt_and_does_not_continue(self) -> None:
        context = self._write_context()
        calls: list[str] = []

        def failing_stage(name, command, *, workspace, artifacts, environment):
            calls.append(name)
            logs = artifacts / "logs"
            logs.mkdir(exist_ok=True)
            (logs / f"{name}.stdout.log").write_text("failed\n", encoding="utf-8")
            (logs / f"{name}.stderr.log").write_text("error\n", encoding="utf-8")
            return {
                "name": name,
                "command": command,
                "started_at": "now",
                "finished_at": "now",
                "duration_ms": 1,
                "exit_code": 17,
                "stdout_log": f"logs/{name}.stdout.log",
                "stderr_log": f"logs/{name}.stderr.log",
                "stdout_tail": "failed",
                "stderr_tail": "error",
            }

        with patch.object(
            entrypoint,
            "preflight",
            return_value={"make": "/usr/bin/make", "pnpm": "/usr/bin/pnpm"},
        ), patch.object(entrypoint, "toolchain_versions", return_value={}), patch.object(
            entrypoint, "run_stage", side_effect=failing_stage
        ):
            code = entrypoint.main(self._argv(context))

        self.assertEqual(code, 2)
        self.assertEqual(calls, ["native-build"])
        receipt = json.loads((self.artifacts / "build-receipt.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(receipt["stages"][0]["exit_code"], 17)
        self.assertIn("managed stage failed", receipt["error"])


if __name__ == "__main__":
    unittest.main()
