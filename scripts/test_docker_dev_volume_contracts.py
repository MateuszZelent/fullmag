"""Dependency-free checks for Docker image scoping and error reporting."""
from __future__ import annotations

from contextlib import contextmanager, redirect_stderr
import io
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import docker_dev  # noqa: E402
from docker_build_control import DockerBuildControlError  # noqa: E402
from docker_build_volume_io import VolumeBuildError  # noqa: E402


class GroupImageSeedTests(unittest.TestCase):
    @staticmethod
    def _seed(project: str, worktree: str, context: str) -> str:
        identity = {"project_name": project, "worktree_id": worktree}
        with patch.object(docker_dev, "_compose_identity", return_value=identity):
            return docker_dev._group_image_seed({}, context)

    def test_seed_is_stable_for_project_worktree_and_context(self):
        context = "a" * 64
        seed = self._seed("fullmag-worktree-alpha", "alpha", context)

        self.assertEqual(seed, self._seed("fullmag-worktree-alpha", "alpha", context))
        self.assertRegex(seed, r"^[0-9a-f]{64}$")

    def test_seed_changes_with_project_worktree_or_context(self):
        baseline = self._seed("fullmag-worktree-alpha", "alpha", "a" * 64)

        variants = (
            self._seed("fullmag-worktree-beta", "alpha", "a" * 64),
            self._seed("fullmag-worktree-alpha", "beta", "a" * 64),
            self._seed("fullmag-worktree-alpha", "alpha", "b" * 64),
        )
        for changed_seed in variants:
            with self.subTest(seed=changed_seed):
                self.assertNotEqual(baseline, changed_seed)


class ImageReferencePresenceTests(unittest.TestCase):
    def test_only_explicit_absent_image_errors_return_false(self):
        for message in (
            "Error response from daemon: no such image: fullmag/example:tag",
            "Error response from daemon: no such object: fullmag/example:tag",
            "image not found: fullmag/example:tag",
        ):
            with self.subTest(message=message), patch.object(
                docker_dev,
                "_docker_capture",
                side_effect=docker_dev.DirectDockerError(message),
            ):
                self.assertFalse(docker_dev._image_reference_present("fullmag/example:tag"))

    def test_daemon_and_unknown_outcome_errors_propagate(self):
        errors = (
            docker_dev.DirectDockerError("Cannot connect to the Docker daemon"),
            docker_dev.DirectDockerOutcomeUnknown("Docker inspect timed out"),
        )
        for error in errors:
            with self.subTest(error=type(error).__name__), patch.object(
                docker_dev, "_docker_capture", side_effect=error
            ):
                with self.assertRaises(type(error)) as caught:
                    docker_dev._image_reference_present("fullmag/example:tag")
                self.assertIs(caught.exception, error)

    def test_successful_inspection_returns_true(self):
        with patch.object(docker_dev, "_docker_capture", return_value="[]") as capture:
            self.assertTrue(docker_dev._image_reference_present("fullmag/example:tag"))
        capture.assert_called_once_with("image", "inspect", "fullmag/example:tag", timeout=60)


class DockerDevMainErrorTests(unittest.TestCase):
    def test_volume_errors_return_two_and_print_their_message(self):
        for error_type in (VolumeBuildError, DockerBuildControlError):
            error = error_type("volume contract rejected the operation")
            stderr = io.StringIO()
            with self.subTest(error_type=error_type.__name__), \
                    patch.object(docker_dev, "build", side_effect=error), \
                    redirect_stderr(stderr):
                result = docker_dev.main(["build"])

            self.assertEqual(result, 2)
            self.assertEqual(
                stderr.getvalue(),
                "docker-dev: volume contract rejected the operation\n",
            )


class UpLockOrderingTests(unittest.TestCase):
    def test_up_prepares_run_root_before_lock_and_starts_after_unlock(self):
        import fullmag_docker_runtime

        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary) / "repo"
            selected = Path(temporary) / "selected"
            repo.mkdir()
            selected.mkdir()
            layout = object()
            identity = {"project_name": "fullmag-worktree-contract"}
            run_id = "a" * 32
            run_root = Path(temporary) / "runs" / run_id
            backend_start = {"device_access": "gpu"}
            lock_active = False
            events = []

            @contextmanager
            def tracked_lock(_layout):
                nonlocal lock_active
                self.assertFalse(lock_active)
                lock_active = True
                events.append("lock-enter")
                try:
                    yield
                finally:
                    lock_active = False
                    events.append("lock-exit")

            def select_source(_repo, _source_root):
                events.append("select-source")
                return selected, layout

            def allocate_run_root(_layout):
                self.assertFalse(lock_active)
                events.append("new-run-root")
                return run_id, run_root

            def prepare_backend_start(_args, **kwargs):
                self.assertTrue(lock_active)
                self.assertIs(_args.source_root, selected)
                self.assertTrue(kwargs["heavy_lock_held"])
                self.assertIs(kwargs["run_root"], run_root)
                self.assertEqual(kwargs["run_id"], run_id)
                events.append("backend-start-inputs")
                return backend_start, Path(temporary)

            def check_running(_project, _identity):
                events.append("assert-no-running-backend")

            def check_port(port, project):
                self.assertEqual(port, 3197)
                self.assertEqual(project, identity["project_name"])
                events.append("check-port")

            def start(*_args, **kwargs):
                self.assertFalse(lock_active)
                self.assertIs(kwargs["backend_start"], backend_start)
                self.assertEqual(kwargs["source_root"], selected)
                events.append("start")

            args = SimpleNamespace(
                repo_root=repo,
                source_root=selected,
                script=None,
                gpu_access=None,
                port=3197,
            )

            with patch.object(docker_dev, "_require_native_windows"), \
                    patch.object(docker_dev, "_select_source", side_effect=select_source), \
                    patch.object(docker_dev, "_compose_identity", return_value=identity), \
                    patch.object(docker_dev, "_assert_no_running_fullmag", side_effect=check_running), \
                    patch.object(fullmag_docker_runtime, "assert_loopback_port_available", side_effect=check_port), \
                    patch.object(docker_dev, "_direct_heavy_lock", side_effect=tracked_lock), \
                    patch.object(docker_dev, "_new_run_root", side_effect=allocate_run_root), \
                    patch.object(docker_dev, "_backend_start_inputs", side_effect=prepare_backend_start), \
                    patch.object(fullmag_docker_runtime, "start", side_effect=start):
                docker_dev.up(args)

            self.assertEqual(
                events,
                [
                    "select-source",
                    "assert-no-running-backend",
                    "check-port",
                    "new-run-root",
                    "lock-enter",
                    "backend-start-inputs",
                    "lock-exit",
                    "assert-no-running-backend",
                    "start",
                ],
            )


if __name__ == "__main__":
    unittest.main()
