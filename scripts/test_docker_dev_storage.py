"""Volume-only storage regressions for the direct Docker development launcher."""

from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_dev
import fullmag_storage
import fullmag_docker_runtime as runtime


class DockerDevStorageTests(unittest.TestCase):
    def test_select_source_uses_runtime_only_storage_initialization(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repo"
            repo.mkdir()
            layout = {"profile": "docker-all-gpu"}
            with patch("docker_development_inputs.select_checkout", return_value=repo), \
                    patch.object(fullmag_storage, "resolve_layout", return_value=layout), \
                    patch.object(fullmag_storage, "initialize_runtime") as initialize_runtime:
                selected, observed = docker_dev._select_source(repo, None)

            self.assertEqual(selected, repo.resolve())
            self.assertIs(observed, layout)
            initialize_runtime.assert_called_once_with(layout)

    def test_project_image_and_control_volume_are_stable_per_group(self):
        project = "fullmag-worktree-example"
        first_image = docker_dev._stable_project_image_reference(project, "runtime")
        second_image = docker_dev._stable_project_image_reference(project, "runtime")

        self.assertEqual(first_image, second_image)
        self.assertIn("-dev:live-shadow-v1", first_image)
        self.assertEqual(
            docker_dev._control_volume_name(project),
            docker_dev._control_volume_name(project),
        )

    def test_control_paths_reject_host_escape(self):
        with self.assertRaises(docker_dev.DirectDockerError):
            docker_dev._control_relative_path("docker-dev/../host.log")
        with self.assertRaises(docker_dev.DirectDockerError):
            docker_dev._control_relative_from_guest("/tmp/build.log")

    def test_helper_inventory_cannot_stage_to_host(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(docker_dev.DirectDockerError):
                docker_dev._image_helper_inventory("image-id", Path(directory) / "context")

    def test_docker_live_persists_bounded_output_in_control_only(self):
        process = Mock()
        process.stdout = io.StringIO("build line\n")
        process.wait.return_value = 0
        with tempfile.TemporaryDirectory() as directory:
            host_log = Path(directory) / "build.log"
            with patch.object(docker_dev, "_docker_argv", return_value=["docker", "version"]), \
                    patch.object(docker_dev.subprocess, "Popen", return_value=process), \
                    patch.object(docker_dev, "_write_control") as write_control:
                docker_dev._docker_live(
                    host_log,
                    "version",
                    timeout=1,
                    control_repo=Path(directory),
                    control_project="fullmag-master",
                    control_relative="docker-dev/build.log",
                )

            self.assertFalse(host_log.exists())
            write_control.assert_called_once()
            self.assertEqual(write_control.call_args.args[1], "fullmag-master")
            self.assertEqual(write_control.call_args.args[2], "docker-dev/build.log")
            self.assertIn(b"build line", write_control.call_args.args[3])

    def test_live_assembly_uses_control_volume_without_host_receipt(self):
        """Live package provenance must not create a host build receipt."""

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_root = root / "run"
            host_builds = root / "storage" / "builds"
            source = root / "checkout"
            run_root.mkdir(parents=True)
            source.mkdir()
            layout = {
                "build_storage_root": host_builds,
            }
            source_bundle = {
                "source_mode": "live-shadow-v1",
                "resolved_commit": "a" * 40,
                "source_digest": "b" * 64,
                "source_snapshot_sha256": "c" * 64,
                "native_source_identity": {
                    "head_commit_full": "a" * 40,
                    "source_snapshot_sha256": "c" * 64,
                },
                "live_manifest_sha256": "d" * 64,
                "git_common_dir": "/opt/fullmag/source-git",
            }
            prepare_receipt = {
                "schema": "fullmag.direct-compose.backend-build-receipt.v1",
                "build": {
                    "cargo_profile": "backend-dev",
                    "cargo_target_profile_dir": "backend-dev",
                },
                "artifacts": [
                    {"path": f"bin/{name}", "sha256": "e" * 64}
                    for name in runtime.REQUIRED_BINARIES
                ],
            }
            image_document = {
                "Config": {
                    "Labels": {"org.fullmag.runtime": "docker-all-gpu-v1"},
                    "Volumes": None,
                },
            }

            with patch.object(docker_dev, "_image_helper_inventory", return_value={}), \
                    patch.object(docker_dev, "_inspect_image",
                                 return_value=("sha256:" + "f" * 64, image_document)), \
                    patch.object(docker_dev, "_compose_identity",
                                 return_value={"project_name": "fullmag-worktree-live"}), \
                    patch.object(docker_dev, "_write_control_json",
                                 return_value="/opt/fullmag/control/docker-dev/live.json") as write_control, \
                    patch.object(fullmag_storage, "atomic_json") as atomic_json, \
                    patch.object(docker_dev, "_write_json") as write_json:
                receipt = docker_dev._assembly(
                    layout,
                    "1" * 32,
                    run_root,
                    source,
                    source_bundle,
                    Path("/opt/fullmag/package"),
                    "sha256:" + "f" * 64,
                    "sha256:" + "0" * 64,
                    prepare_receipt,
                    json.dumps(prepare_receipt).encode("utf-8"),
                    {"reference": "fullmag/base:dev", "image_id": "sha256:" + "1" * 64},
                    "dev",
                    "backend-dev",
                )

            self.assertTrue(
                receipt.as_posix().startswith(
                    "/opt/fullmag/control/docker-dev/live-assembly/"
                )
            )
            atomic_json.assert_not_called()
            write_json.assert_not_called()
            write_control.assert_called_once()
            assembly = write_control.call_args.args[3]
            self.assertEqual(assembly["package_root"], "/opt/fullmag/package")
            self.assertEqual(assembly["output"], receipt.as_posix())
            self.assertFalse(host_builds.exists())


if __name__ == "__main__":
    unittest.main()
