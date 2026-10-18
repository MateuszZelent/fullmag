"""Launcher contract checks for archive/reproducible and live/dev inputs."""
from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

import docker_dev


class LiveSourceLauncherTests(unittest.TestCase):
    def test_live_override_has_no_archive_argument(self):
        service = {
            "entrypoint": ["python3", "/opt/fullmag/backend_dev.py"],
            "command": [
                "prepare", "--manifest", "/input/manifest.json",
                "--source-root", "/opt/fullmag/source",
                "--git-common-root", "/opt/fullmag/source-git",
                "--output", "/opt/fullmag/package", "--build-root", "/build",
            ],
            "volumes": [
                {"target": "/input/manifest.json"},
                {"target": "/opt/fullmag/source"},
                {"target": "/opt/fullmag/source-git"},
                {"target": "/opt/fullmag/package"},
                {"target": "/build"},
            ],
        }
        self.assertEqual(docker_dev._prepare_override(service, "live-shadow-v1"), [])

    def test_archive_override_retains_tar_contract(self):
        service = {
            "entrypoint": ["python3", "/opt/fullmag/backend_dev.py"],
            "command": [
                "prepare", "--source-tar", "/input/backend-source.tar",
                "--manifest", "/input/manifest.json",
                "--output", "/opt/fullmag/package", "--build-root", "/build",
            ],
            "volumes": [
                {"target": "/input/backend-source.tar"},
                {"target": "/input/manifest.json"},
                {"target": "/opt/fullmag/package"},
                {"target": "/build"},
            ],
        }
        self.assertEqual(docker_dev._prepare_override(service, "archive"), [])

    def test_compose_file_selection_is_profile_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            (repo / docker_dev.COMPOSE_RUNTIME_FILE).write_text("services: {}\n", encoding="utf-8")
            (repo / docker_dev.COMPOSE_BUILD_FILE).write_text("services: {}\n", encoding="utf-8")
            (repo / docker_dev.COMPOSE_LIVE_BUILD_FILE).write_text("services: {}\n", encoding="utf-8")
            archive = docker_dev._direct_compose_files(repo, source_mode="archive")
            live = docker_dev._direct_compose_files(repo, source_mode="live-shadow-v1")
            self.assertEqual(archive[-1].name, docker_dev.COMPOSE_BUILD_FILE)
            self.assertEqual(live[-1].name, docker_dev.COMPOSE_LIVE_BUILD_FILE)


if __name__ == "__main__":
    unittest.main()
