#!/usr/bin/env python3
"""Interpreted admission and frozen-context regressions; no Docker build."""
from pathlib import Path
import os
import json
import sys
import tempfile
import unittest
from unittest import mock

import bootstrap_docker_toolchain as bootstrap


class ToolchainBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / "docker/fem-gpu/nvidia-entrypoint").mkdir(parents=True)
        (self.repo / "docker/fem-gpu/Dockerfile").write_text("FROM scratch\n")
        (self.repo / "docker/fem-gpu/nvidia-entrypoint/run.sh").write_text("true\n")
        (self.repo / ".dockerignore").write_text("**\n!docker/\n!docker/**\n")
        (self.repo / "compose.toolchain.yaml").write_text("services: {}\n")
        self.tracked = [".dockerignore", "compose.toolchain.yaml", "docker/fem-gpu/Dockerfile",
                        "docker/fem-gpu/nvidia-entrypoint/run.sh"]
        git = mock.patch.object(bootstrap.storage, "git",
                                side_effect=lambda *_: "\0".join(self.tracked) + "\0")
        git.start()
        self.addCleanup(git.stop)
        self.context = self.root / "context"
        self.context.mkdir()
        self.storage = self.root / "storage"
        (self.storage / "index").mkdir(parents=True)

    def test_direct_dependency_build_uses_main_checkout_group(self):
        layout = {"repo_root": str(self.repo), "worktree_id": "main-123",
                  "env": {"FULLMAG_PROJECT_ID": "fullmag-test"}}
        with mock.patch.object(bootstrap.storage, "worktree_records",
                               return_value=[{"worktree": str(self.repo)}]):
            self.assertEqual(bootstrap.compose_project(layout, direct_development=True),
                             "fullmag-master")

    def test_direct_dependency_build_uses_selected_worktree_group(self):
        layout = {"repo_root": str(self.repo), "worktree_id": "feature-abc123",
                  "env": {"FULLMAG_PROJECT_ID": "fullmag-test"}}
        with mock.patch.object(bootstrap.storage, "worktree_records",
                               return_value=[{"worktree": str(self.root / "main")} ]):
            self.assertEqual(bootstrap.compose_project(layout, direct_development=True),
                             "fullmag-worktree-feature-abc123")
            self.assertEqual(bootstrap.compose_project(layout), "fullmag-worktree-feature-abc123")

    def test_invalid_checkout_binding_cannot_fall_back_to_shared_toolchain_group(self):
        with self.assertRaises(ValueError):
            bootstrap.compose_project({}, direct_development=True)

    def test_control_volume_is_stable_and_group_scoped(self):
        project = "fullmag-worktree-feature-abc123"
        volume = bootstrap.control_volume_name(project)
        self.assertEqual(volume, bootstrap.control_volume_name(project))
        self.assertTrue(volume.startswith("fullmag-build-control-"))
        self.assertEqual(bootstrap._control_environment(project), {
            "FULLMAG_COMPOSE_PROJECT": project,
            "FULLMAG_BUILD_CONTROL_VOLUME": volume,
            "FULLMAG_CONTROL_ROOT": "/opt/fullmag/control",
        })
        self.assertNotEqual(volume, bootstrap.control_volume_name("fullmag-master"))

    def test_toolchain_image_is_stable_and_group_scoped(self):
        project = "fullmag-worktree-feature-abc123"
        image = bootstrap.toolchain_image_reference(project)
        self.assertEqual(image, bootstrap.toolchain_image_reference(project))
        self.assertEqual(image.split(":", 1)[1], "cuda12.6.3")
        self.assertTrue(image.startswith("fullmag/fullmag-worktree-feature-abc123-"))
        self.assertNotEqual(image, bootstrap.toolchain_image_reference("fullmag-master"))

    def test_existing_storage_is_admitted_without_creating_build_data(self):
        target = self.root / "storage"
        probes = []
        def admit_existing(path):
            if not path.is_dir():
                raise ValueError("Volume probe requires an existing directory")
            probes.append(path)
        with mock.patch.object(bootstrap.storage, "initialize") as initialize:
            bootstrap.initialize_host_storage({"storage_root": str(target)}, admit_existing)
        initialize.assert_not_called()
        self.assertEqual(probes, [target])

    def test_failed_parent_volume_admission_does_not_create_storage(self):
        target = self.root / "not-created" / "storage"
        with mock.patch.object(bootstrap.storage, "initialize") as initialize:
            with self.assertRaisesRegex(bootstrap.BootstrapError, "existing configured storage"):
                bootstrap.initialize_host_storage({"storage_root": str(target)},
                                                  mock.Mock(side_effect=ValueError("unsupported volume")))
            initialize.assert_not_called()
        self.assertFalse(target.exists())

    def test_bounded_probe_returns_small_complete_output(self):
        self.assertEqual(bootstrap.bounded_command([sys.executable, "-c", "print('manifest')"],
                                                  maximum=128, timeout=5).strip(), "manifest")

    def test_bounded_probe_rejects_output_before_unbounded_buffering(self):
        with self.assertRaisesRegex(bootstrap.BootstrapError, "bound|limit"):
            bootstrap.bounded_command([sys.executable, "-c", "import sys; sys.stdout.write('x'*1048576)"],
                                      maximum=128, timeout=5)

    def test_bounded_probe_cannot_block_forever(self):
        with self.assertRaisesRegex(bootstrap.BootstrapError, "timed out"):
            bootstrap.bounded_command([sys.executable, "-c", "import time; time.sleep(30)"],
                                      maximum=128, timeout=0.1)

    def test_direct_mode_admission_allows_enrolled_host(self):
        (self.storage / "index/local-runner-container.json").write_text("{}")
        bootstrap.assert_bootstrap_reconciled(self.storage)
        with self.assertRaisesRegex(bootstrap.BootstrapError, "already has a build runner"):
            bootstrap.assert_fresh_host(self.storage)

    def test_direct_mode_retains_unknown_build_barrier(self):
        path = self.storage / "index/docker-toolchain-bootstrap.json"
        path.write_text(json.dumps({"schema": "fullmag.docker-toolchain-bootstrap.v1",
                                    "state": "outcome_unknown_resources_retained"}))
        with self.assertRaisesRegex(bootstrap.BootstrapError, "reconciliation"):
            bootstrap.assert_bootstrap_reconciled(self.storage)
        self.assertTrue(path.exists())

    def test_unconfirmed_prior_daemon_build_blocks_retry(self):
        path = self.storage / "index/docker-toolchain-bootstrap.json"
        path.write_text(json.dumps({"schema":"fullmag.docker-toolchain-bootstrap.v1",
                                    "state":"outcome_unknown_resources_retained"}))
        with self.assertRaisesRegex(bootstrap.BootstrapError, "reconciliation"):
            bootstrap.assert_fresh_host(self.storage)

    def test_confirmed_failure_allows_new_attempt_without_erasing_prior_receipts(self):
        path = self.storage / "index/docker-toolchain-bootstrap.json"
        path.write_text(json.dumps({"schema":"fullmag.docker-toolchain-bootstrap.v1",
                                    "state":"failed_confirmed"}))
        bootstrap.assert_fresh_host(self.storage)
        self.assertTrue(path.is_file())

    def test_fresh_storage_is_admitted(self):
        bootstrap.assert_fresh_host(self.storage)

    def test_existing_coordinator_is_never_bypassed(self):
        (self.storage / "index/local-runner-container.json").write_text("{}")
        with self.assertRaisesRegex(bootstrap.BootstrapError, "already has a build runner"):
            bootstrap.assert_fresh_host(self.storage)

    def test_existing_host_runner_is_never_bypassed(self):
        (self.storage / "index/local-runner-config.json").write_text("{}")
        with self.assertRaises(bootstrap.BootstrapError):
            bootstrap.assert_fresh_host(self.storage)

    def test_existing_queue_blocks_bootstrap_even_without_active_rows_or_config(self):
        (self.storage / "index/runner-jobs.sqlite").touch()
        with self.assertRaisesRegex(bootstrap.BootstrapError, "existing build queue"):
            bootstrap.assert_fresh_host(self.storage)

    def test_pending_host_service_stop_blocks_bootstrap(self):
        (self.storage / "index/local-runner-service.stop.json").write_text("{}")
        with self.assertRaisesRegex(bootstrap.BootstrapError, "already has a build runner"):
            bootstrap.assert_fresh_host(self.storage)

    def test_context_excludes_application_git_and_credentials(self):
        (self.repo / ".env").write_text("SECRET=never-copy")
        (self.repo / "application.rs").write_text("never-copy")
        (self.repo / ".git").mkdir()
        (self.repo / ".git/config").write_text("never-copy")
        manifest = bootstrap.capture_inputs(self.repo)
        self.assertEqual({item["path"] for item in manifest}, {
            ".dockerignore", "compose.toolchain.yaml", "docker/fem-gpu/Dockerfile",
            "docker/fem-gpu/nvidia-entrypoint/run.sh",
        })
        bootstrap.verify_capture(self.repo, manifest)
        self.assertEqual(tuple(self.context.iterdir()), ())
        self.assertFalse((self.context / ".env").exists())
        self.assertFalse((self.context / ".git").exists())

    def test_untracked_dependency_secret_is_not_copied(self):
        (self.repo / "docker/fem-gpu/.env").write_text("SECRET=never-copy")
        bootstrap.capture_inputs(self.repo)
        self.assertEqual(tuple(self.context.iterdir()), ())

    def test_missing_tracked_canonical_input_is_rejected(self):
        self.tracked.remove("docker/fem-gpu/Dockerfile")
        with self.assertRaisesRegex(bootstrap.BootstrapError, "Git-tracked"):
            bootstrap.capture_inputs(self.repo)

    def test_frozen_content_tampering_is_rejected(self):
        manifest = bootstrap.capture_inputs(self.repo)
        (self.repo / "docker/fem-gpu/Dockerfile").write_text("FROM different\n")
        with self.assertRaisesRegex(bootstrap.BootstrapError, "input changed"):
            bootstrap.verify_capture(self.repo, manifest)

    def test_frozen_inventory_tampering_is_rejected(self):
        manifest = bootstrap.capture_inputs(self.repo)
        self.tracked.append("docker/fem-gpu/extra")
        (self.repo / "docker/fem-gpu/extra").write_text("changed")
        with self.assertRaisesRegex(bootstrap.BootstrapError, "inventory changed"):
            bootstrap.verify_capture(self.repo, manifest)

    def test_mutation_during_capture_is_rejected(self):
        real_read = bootstrap.read_input
        count = 0
        def changing_read(repo, relative):
            nonlocal count
            count += 1
            data = real_read(repo, relative)
            if count == 1:
                (self.repo / relative).write_bytes(data + b"changed")
            return data
        with mock.patch.object(bootstrap, "read_input", side_effect=changing_read):
            with self.assertRaisesRegex(bootstrap.BootstrapError, "changed during capture"):
                bootstrap.capture_inputs(self.repo)

    def test_oversized_dependency_input_is_rejected(self):
        with mock.patch.object(bootstrap, "MAX_INPUT_BYTES", 1):
            with self.assertRaises((bootstrap.BootstrapError, ValueError)):
                bootstrap.capture_inputs(self.repo)

    @unittest.skipIf(os.name == "nt", "Windows junction coverage uses native host helpers")
    def test_context_directory_symlink_is_rejected(self):
        (self.repo / "docker/fem-gpu/linked").symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(bootstrap.BootstrapError, "directory links"):
            bootstrap.capture_inputs(self.repo)

    @unittest.skipIf(os.name == "nt", "Windows reparse coverage uses native host helpers")
    def test_context_file_symlink_is_rejected(self):
        (self.repo / "docker/fem-gpu/linked").symlink_to(self.repo / ".env")
        self.tracked.append("docker/fem-gpu/linked")
        with self.assertRaises((bootstrap.BootstrapError, bootstrap.storage.StorageError, OSError)):
            bootstrap.capture_inputs(self.repo)


if __name__ == "__main__":
    unittest.main()
