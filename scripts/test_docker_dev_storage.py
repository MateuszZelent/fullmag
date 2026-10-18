"""Volume-only storage regressions for the direct Docker development launcher."""

from __future__ import annotations

import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_dev


class DockerDevStorageTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
