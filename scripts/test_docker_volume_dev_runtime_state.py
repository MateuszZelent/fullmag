"""Regressions for native preparation of a fresh Windows runtime state."""

from __future__ import annotations

import inspect
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_dev


class DockerVolumeDevRuntimeStateTests(unittest.TestCase):
    def test_actual_process_probe_reads_runtime_control_receipt_and_missing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            control = Path(directory) / "runtime-control"
            receipt = control / "runtime-service" / "process-tree.json"
            receipt.parent.mkdir(parents=True)
            expected = {"state": "failed-confirmed", "error": "admission closed"}
            receipt.write_text(json.dumps(expected))
            environment = {
                "PATH": os.environ.get("PATH", ""),
                "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "docker/all-in-one"),
                "FULLMAG_RUNTIME_CONTROL_ROOT": str(control),
            }
            for present in (True, False):
                if not present:
                    receipt.unlink()
                result = subprocess.run(
                    [sys.executable, "-B", "-c", docker_volume_dev.BACKEND_PROCESS_RECEIPT_SCRIPT],
                    env=environment, text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), expected if present else {"state": "not-published"})

    @staticmethod
    def _development_context():
        identity = {
            "project_name": "fullmag-worktree-test",
            "project_id": "fullmag",
            "worktree_id": "worktree-test",
            "checkout_kind": "worktree",
        }
        control = docker_volume_dev.BuildControl.__new__(docker_volume_dev.BuildControl)
        control.identity = dict(identity)
        control.project = identity["project_name"]
        operation = {
            "root": "development/attempts/" + "a" * 32,
            "lease_ready": True,
            "receipt": {
                "phase": "development",
                "attempt": "a" * 32,
                "compose_project": identity["project_name"],
                "inputs": {
                    "source_root": "/checkout",
                    "source_project_id": identity["project_id"],
                    "source_worktree_id": identity["worktree_id"],
                    "source_checkout_kind": identity["checkout_kind"],
                },
            },
        }
        return identity, control, operation

    def test_recovery_reuses_only_matching_development_operation(self):
        identity, control, operation = self._development_context()
        receipt = docker_volume_dev._validate_existing_development_operation(
            control, operation, Path("/checkout"), identity
        )
        self.assertEqual(receipt["phase"], "development")
        self.assertEqual(
            docker_volume_dev._validate_prepared_start_context(
                {
                    "toolchain": {
                        "image_id": "sha256:" + "b" * 64,
                        "inputs": {"build_args": {}},
                    },
                    "images": {"backend": {"image_id": "sha256:" + "c" * 64}},
                }
            )[0]["image_id"],
            "sha256:" + "b" * 64,
        )
        operation["receipt"]["phase"] = "resume"
        with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "development phase"):
            docker_volume_dev._validate_existing_development_operation(
                control, operation, Path("/checkout"), identity
            )

    def test_recovery_context_rejects_identity_and_environment_override(self):
        identity, control, operation = self._development_context()
        operation["receipt"]["inputs"]["source_root"] = "/other-checkout"
        with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "source differs"):
            docker_volume_dev._validate_existing_development_operation(
                control, operation, Path("/checkout"), identity
            )
        self.assertEqual(
            docker_volume_dev._validate_recovery_environment(
                {"FULLMAG_CONTAINER_RECOVERY_REQUEST": "request-1"}
            ),
            {"FULLMAG_CONTAINER_RECOVERY_REQUEST": "request-1"},
        )
        for name in ("FULLMAG_SOURCE_ROOT", "PATH"):
            with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "unsupported"):
                docker_volume_dev._validate_recovery_environment({name: "value"})

    def test_precreate_uses_real_write_probe_and_exact_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            state.mkdir()

            with patch.object(docker_volume_dev.sys, "platform", "win32"):
                prepared = docker_volume_dev._precreate_new_windows_runtime_state(state)

            expected = tuple(
                relative.as_posix()
                for relative in docker_volume_dev._NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES
            )
            self.assertEqual(prepared, expected)
            for relative in expected:
                self.assertTrue((state / relative).is_dir())
            self.assertEqual(
                list((state / expected[-1]).iterdir()),
                [],
                "the write probe must not leave technical files in Windows runtime state",
            )

    def test_precreate_rejects_existing_runtime_data_without_adopting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            existing = state / "runs/docker-all/session-store"
            existing.mkdir(parents=True)
            marker = existing / "existing.json"
            marker.write_text("keep", encoding="utf-8")

            with patch.object(docker_volume_dev.sys, "platform", "win32"), self.assertRaises(
                docker_volume_dev.BuildControlError
            ):
                docker_volume_dev._precreate_new_windows_runtime_state(state)

            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")
            self.assertTrue(existing.is_dir())

    def test_precreate_rejects_reparse_entry_before_creating_children(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            state.mkdir()
            redirected = root / "outside"
            redirected.mkdir()
            try:
                (state / "runs").symlink_to(redirected, target_is_directory=True)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlink test requires native reparse support: {error}")

            with patch.object(docker_volume_dev.sys, "platform", "win32"), self.assertRaises(
                docker_volume_dev.BuildControlError
            ):
                docker_volume_dev._precreate_new_windows_runtime_state(state)

            self.assertEqual(list(redirected.iterdir()), [])
            self.assertFalse((redirected / "docker-all").exists())

    def test_start_wires_preparation_before_mount_and_compose(self):
        source = inspect.getsource(docker_volume_dev.start)
        self.assertLess(
            source.index("_precreate_new_windows_runtime_state(state)"),
            source.index("local_volume(state)"),
        )
        self.assertLess(
            source.index("_precreate_new_windows_runtime_state(state)"),
            source.index("_start_compose_services(control, operation, document)"),
        )


if __name__ == "__main__":
    unittest.main()
