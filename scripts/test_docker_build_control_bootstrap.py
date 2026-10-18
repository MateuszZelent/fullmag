from __future__ import annotations

from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

CONTROL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(CONTROL_ROOT / "scripts"))

import docker_build_control_bootstrap as helper  # noqa: E402
import docker_compose_identity  # noqa: E402


IMAGE_ID = "sha256:" + "8" * 64
DERIVED_IMAGE_ID = "sha256:" + "a" * 64


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


class FakeStdin:
    def __init__(self, on_close):
        self.buffer = bytearray()
        self.on_close = on_close
        self.closed = False

    def write(self, value):
        self.buffer.extend(value)
        return len(value)

    def flush(self):
        return None

    def close(self):
        self.closed = True
        self.on_close(bytes(self.buffer))


class FakeOutput:
    def __init__(self, chunks=None):
        self.chunks = list(chunks or [b"buildkit output\n"])
        self.read_calls = 0
        self.closed = False

    def read(self, _size):
        self.read_calls += 1
        return self.chunks.pop(0) if self.chunks else b""

    def close(self):
        self.closed = True


class FakeProcess:
    def __init__(self, on_close, exit_code=0, output=None):
        self.exit_code = exit_code
        self.wait_calls = 0
        self.stdin = FakeStdin(on_close)
        self.stdout = FakeOutput(output)

    def wait(self):
        self.wait_calls += 1
        return self.exit_code


class FakeDocker:
    def __init__(self, images=None, *, build_exit=0):
        self.images = dict(images or {})
        self.build_exit = build_exit
        self.inspect_calls = []
        self.popen_calls = []
        self.processes = []
        self.lock_held = False
        self.popen_environment = None

    def run(self, argv, **kwargs):
        argv = list(argv)
        self.inspect_calls.append((argv, kwargs))
        if argv[:3] != ["docker", "--context", "desktop-linux"]:
            raise AssertionError("All helper inspection must pin Docker Desktop's Linux context")
        if argv[3:5] != ["image", "inspect"] or argv[-2:] != ["--format", "{{json .}}"]:
            raise AssertionError(f"Unexpected Docker inspection command: {argv!r}")
        reference = argv[5]
        image = self.images.get(reference)
        if image is None:
            return subprocess.CompletedProcess(argv, 1, "", f"Error response from daemon: No such image: {reference}")
        return subprocess.CompletedProcess(argv, 0, json.dumps(image), "")

    def popen(self, argv, **kwargs):
        argv = list(argv)
        self.popen_calls.append((argv, kwargs))
        self.popen_environment = kwargs.get("env")
        if not self.lock_held:
            raise AssertionError("BuildKit helper image construction must hold the canonical heavy lock")
        if argv[:3] != ["docker", "--context", "desktop-linux"]:
            raise AssertionError("Helper BuildKit command must pin Docker Desktop's Linux context")
        if argv[3:5] != ["compose", "--project-name"]:
            raise AssertionError(f"Unexpected Compose command: {argv!r}")
        if argv[-4:] != ["-", "build", "--pull=false", "build-control-base"]:
            raise AssertionError(f"Helper must use an ephemeral Compose build-only service: {argv!r}")
        if kwargs.get("stdout") != subprocess.PIPE or kwargs.get("stderr") != subprocess.STDOUT:
            raise AssertionError("BuildKit output must be drained as one binary console stream")
        if "up" in argv or "--iidfile" in argv:
            raise AssertionError("Helper bootstrap must not start a service or create a host iid file")

        def finish_input(raw):
            document = json.loads(raw)
            if set(document["services"]) != {"build-control-base"}:
                raise AssertionError("Build-control bootstrap may define only its one-shot helper service")
            service = document["services"]["build-control-base"]
            args = service["build"]["args"]
            labels = {
                helper.LABEL_SCHEMA: helper.HELPER_SCHEMA,
                helper.LABEL_ROLE: helper.HELPER_ROLE,
                helper.LABEL_PROJECT: args["FULLMAG_CONTROL_PROJECT"],
                helper.LABEL_WORKTREE: args["FULLMAG_CONTROL_WORKTREE_ID"],
                helper.LABEL_BASE_IMAGE: helper.BASE_IMAGE,
                helper.LABEL_DOCKERFILE_SHA256: args["FULLMAG_CONTROL_DOCKERFILE_SHA256"],
                helper.LABEL_BUILD_KEY: args["FULLMAG_CONTROL_BUILD_KEY"],
            }
            self.images[service["image"]] = {
                "Id": DERIVED_IMAGE_ID,
                "Os": "linux",
                "Architecture": "amd64",
                "Config": {"Labels": labels},
            }

        process = FakeProcess(finish_input, self.build_exit, [b"BuildKit bytes: \x9a\n", b"terminal chunk\n"])
        self.processes.append(process)
        return process


class DockerBuildControlBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "checkout"
        (self.root / "docker" / "all-in-one").mkdir(parents=True)
        self.dockerfile = self.root / helper.DOCKERFILE_RELATIVE
        source_dockerfile = (CONTROL_ROOT / helper.DOCKERFILE_RELATIVE).read_bytes()
        self.dockerfile.write_bytes(source_dockerfile)
        (self.root / "compose.toolchain.yaml").write_text(
            helper.BASE_IMAGE + "\n",
            encoding="utf-8",
        )
        self.storage_root = Path(self.temp.name) / "storage"
        (self.storage_root / "locks").mkdir(parents=True)
        self.layout = {
            "repo_root": str(self.root),
            "storage_root": str(self.storage_root),
            "worktree_id": "worktree-0123456789abcdef",
        }
        self.identity = {
            "project_name": "fullmag-worktree-worktree-0123456789abcdef",
            "worktree_id": self.layout["worktree_id"],
            "source_root": str(self.root),
        }
        self.identity_patch = patch.object(
            docker_compose_identity,
            "compose_project_identity",
            return_value=self.identity,
        )
        self.identity_patch.start()
        self.addCleanup(self.identity_patch.stop)

    def tearDown(self):
        self.temp.cleanup()

    def _image(self, image_id=IMAGE_ID, labels=None):
        return {
            "Id": image_id,
            "Os": "linux",
            "Architecture": "amd64",
            "Config": {"Labels": labels or {}},
        }

    def _derived_identity(self):
        dockerfile_sha256 = hashlib.sha256(self.dockerfile.read_bytes()).hexdigest()
        build_identity = {
            "schema": helper.HELPER_SCHEMA,
            "project": self.identity["project_name"],
            "worktree_id": self.identity["worktree_id"],
            "base_image": helper.BASE_IMAGE,
            "dockerfile_sha256": dockerfile_sha256,
        }
        build_key = hashlib.sha256(_canonical(build_identity)).hexdigest()
        labels = {
            helper.LABEL_SCHEMA: helper.HELPER_SCHEMA,
            helper.LABEL_ROLE: helper.HELPER_ROLE,
            helper.LABEL_PROJECT: self.identity["project_name"],
            helper.LABEL_WORKTREE: self.identity["worktree_id"],
            helper.LABEL_BASE_IMAGE: helper.BASE_IMAGE,
            helper.LABEL_DOCKERFILE_SHA256: dockerfile_sha256,
            helper.LABEL_BUILD_KEY: build_key,
        }
        return f"fullmag/build-control:{build_key}", labels, build_key

    def _call(self):
        return helper.ensure_control_helper(self.layout, self.root)

    def test_explicit_image_is_inspect_only_and_does_not_fall_back(self):
        docker = FakeDocker({"local/custom-helper:stable": self._image()})
        with patch.dict(os.environ, {helper.CONTROL_IMAGE_ENV: "local/custom-helper:stable"}), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen):
            self.assertEqual(self._call(), IMAGE_ID)
        self.assertEqual([call[0][5] for call in docker.inspect_calls], ["local/custom-helper:stable"])
        self.assertEqual(docker.popen_calls, [])

    def test_explicit_missing_image_fails_without_pull_or_derived_build(self):
        docker = FakeDocker()
        with patch.dict(os.environ, {helper.CONTROL_IMAGE_ENV: "local/missing-helper:stable"}), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen):
            with self.assertRaisesRegex(helper.ControlHelperError, "automatic pull/build is disabled"):
                self._call()
        self.assertEqual(len(docker.inspect_calls), 1)
        self.assertEqual(docker.popen_calls, [])

    def test_explicit_image_reference_cannot_become_a_docker_option(self):
        docker = FakeDocker()
        with patch.dict(os.environ, {helper.CONTROL_IMAGE_ENV: "--help"}), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen):
            with self.assertRaisesRegex(helper.ControlHelperError, "image reference is invalid"):
                self._call()
        self.assertEqual(docker.inspect_calls, [])
        self.assertEqual(docker.popen_calls, [])

    def test_image_with_anonymous_volumes_is_rejected(self):
        image = self._image()
        image["Config"]["Volumes"] = {"/build-cache": {}}
        docker = FakeDocker({"local/custom-helper:stable": image})
        with patch.dict(os.environ, {helper.CONTROL_IMAGE_ENV: "local/custom-helper:stable"}), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen):
            with self.assertRaisesRegex(helper.ControlHelperError, "anonymous volumes"):
                self._call()
        self.assertEqual(len(docker.inspect_calls), 1)
        self.assertEqual(docker.popen_calls, [])

    def test_existing_development_base_is_reused_by_immutable_id(self):
        docker = FakeDocker({helper.DEVELOPMENT_BASE_REFERENCE: self._image()})
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen):
            self.assertEqual(self._call(), IMAGE_ID)
        self.assertEqual([call[0][5] for call in docker.inspect_calls], [helper.DEVELOPMENT_BASE_REFERENCE])
        self.assertEqual(docker.popen_calls, [])

    def test_existing_derived_helper_requires_full_project_provenance(self):
        reference, labels, _key = self._derived_identity()
        docker = FakeDocker({reference: self._image(DERIVED_IMAGE_ID, labels)})
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen):
            self.assertEqual(self._call(), DERIVED_IMAGE_ID)
        self.assertEqual([call[0][5] for call in docker.inspect_calls], [helper.DEVELOPMENT_BASE_REFERENCE, reference])
        self.assertEqual(docker.popen_calls, [])

    def test_foreign_deterministic_tag_fails_closed_without_overwrite(self):
        reference, labels, _key = self._derived_identity()
        labels[helper.LABEL_PROJECT] = "fullmag-another-project"
        docker = FakeDocker({reference: self._image(DERIVED_IMAGE_ID, labels)})
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen):
            with self.assertRaisesRegex(helper.ControlHelperError, "foreign or stale provenance"):
                self._call()
        self.assertEqual(docker.popen_calls, [])

    def test_fresh_host_build_uses_pinned_compose_build_and_drains_terminal(self):
        docker = FakeDocker()
        self.identity["project_name"] = (
            "fullmag-worktree-eigensolve-dispersion-plan-20260-c5dfad6d7f548079"
        )
        self.assertGreater(len(self.identity["project_name"]), 63)
        original_context = os.environ.get("DOCKER_CONTEXT")
        original_host = os.environ.get("DOCKER_HOST")
        original_explicit_image = os.environ.get(helper.CONTROL_IMAGE_ENV)
        console = SimpleNamespace(buffer=io.BytesIO())

        @contextmanager
        def tracked_lock(*args, **kwargs):
            expected_lock = self.storage_root / "locks" / "fullmag-heavy.lock"
            self.assertEqual(Path(args[0]), expected_lock)
            self.assertEqual(args[1], "Docker Compose control helper image build")
            self.assertEqual(kwargs["wait_timeout_seconds"], helper.BUILD_LOCK_WAIT_SECONDS)
            docker.lock_held = True
            try:
                yield
            finally:
                docker.lock_held = False

        import fullmag_storage

        @contextmanager
        def lock_factory(*args, **kwargs):
            with tracked_lock(*args, **kwargs):
                yield

        with patch.dict(os.environ, {"DOCKER_CONTEXT": "wrong-context", "DOCKER_HOST": "tcp://wrong"}, clear=True), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen), \
                patch.object(fullmag_storage, "file_lock", side_effect=lock_factory), \
                patch.object(helper.sys, "stdout", console):
            self.assertEqual(self._call(), DERIVED_IMAGE_ID)

        self.assertEqual(os.environ.get("DOCKER_CONTEXT"), original_context)
        self.assertEqual(os.environ.get("DOCKER_HOST"), original_host)
        self.assertEqual(len(docker.popen_calls), 1)
        argv, kwargs = docker.popen_calls[0]
        self.assertEqual(argv[5], self.identity["project_name"])
        self.assertEqual(argv[-4:], ["-", "build", "--pull=false", "build-control-base"])
        self.assertEqual(kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(kwargs["stderr"], subprocess.STDOUT)
        self.assertNotIn("bufsize", kwargs)
        self.assertNotIn("DOCKER_CONTEXT", kwargs["env"])
        self.assertNotIn("DOCKER_HOST", kwargs["env"])
        self.assertTrue(docker.processes[0].stdin.closed)
        self.assertTrue(docker.processes[0].stdout.closed)
        self.assertEqual(docker.processes[0].wait_calls, 1)
        self.assertEqual(docker.processes[0].stdout.read_calls, 3)
        self.assertEqual(console.buffer.getvalue(), b"BuildKit bytes: \x9a\nterminal chunk\n")
        self.assertEqual(len(docker.inspect_calls), 4)
        document = json.loads(bytes(docker.processes[0].stdin.buffer))
        self.assertEqual(document["name"], self.identity["project_name"])
        self.assertEqual(set(document["services"]), {"build-control-base"})
        service = document["services"]["build-control-base"]
        self.assertEqual(service["platform"], "linux/amd64")
        self.assertEqual(service["pull_policy"], "never")
        self.assertEqual(service["build"]["context"], str(self.root / "docker" / "all-in-one"))
        self.assertEqual(service["build"]["dockerfile"], "Dockerfile.build-control")
        self.assertEqual(set(service["build"]["args"]), {
            "FULLMAG_CONTROL_PROJECT",
            "FULLMAG_CONTROL_WORKTREE_ID",
            "FULLMAG_CONTROL_DOCKERFILE_SHA256",
            "FULLMAG_CONTROL_BUILD_KEY",
        })
        self.assertIn(f"FROM {helper.BASE_IMAGE}", self.dockerfile.read_text(encoding="utf-8"))
        self.assertIn("python3-minimal", self.dockerfile.read_text(encoding="utf-8"))

        # The only checkout input is the versioned helper Dockerfile. BuildKit
        # receives the service document over stdin; no host compose/log/receipt
        # was introduced alongside it.
        self.assertEqual(set(self.root.rglob("*")), {
            self.root / "docker",
            self.root / "docker" / "all-in-one",
            self.dockerfile,
            self.root / "compose.toolchain.yaml",
        })
        self.assertEqual(os.environ.get(helper.CONTROL_IMAGE_ENV), original_explicit_image)

    def test_dockerfile_change_during_build_is_not_published(self):
        docker = FakeDocker()
        real_build = helper._build_with_compose

        @contextmanager
        def tracked_lock():
            docker.lock_held = True
            try:
                yield
            finally:
                docker.lock_held = False

        def build_then_change_source(source_root, project, compose_document):
            real_build(source_root, project, compose_document, popen=docker.popen)
            self.dockerfile.write_bytes(self.dockerfile.read_bytes() + b"\n# changed during build\n")

        with patch.dict(os.environ, {}, clear=True), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper, "_heavy_build_lock", return_value=tracked_lock()), \
                patch.object(helper, "_build_with_compose", side_effect=build_then_change_source):
            with self.assertRaisesRegex(helper.ControlHelperError, "changed while BuildKit was building"):
                self._call()
        self.assertEqual(len(docker.popen_calls), 1)
        self.assertEqual(len(docker.inspect_calls), 2)
        self.assertEqual(docker.processes[0].wait_calls, 1)

    def test_console_render_failure_does_not_stop_build_output_drain(self):
        process = FakeProcess(lambda _raw: None, output=[b"chunk one\n", b"chunk two\n"])

        def failing_popen(_argv, **_kwargs):
            return process

        class FailingBuffer:
            def write(self, _value):
                raise OSError("console is unavailable")

        console = SimpleNamespace(buffer=FailingBuffer())
        compose_document = {"services": {"build-control-base": {"image": "local/helper"}}}
        with patch.object(helper.sys, "stdout", console):
            helper._build_with_compose(
                self.root,
                self.identity["project_name"],
                compose_document,
                popen=failing_popen,
            )
        self.assertEqual(process.stdout.read_calls, 3)
        self.assertTrue(process.stdout.closed)
        self.assertEqual(process.wait_calls, 1)

    def test_non_missing_inspect_error_does_not_trigger_build_fallback(self):
        docker = FakeDocker()

        def unavailable_daemon(argv, **kwargs):
            docker.inspect_calls.append((list(argv), kwargs))
            return subprocess.CompletedProcess(argv, 1, "", "Cannot connect to the Docker daemon")

        with patch.dict(os.environ, {}, clear=True), \
                patch.object(helper.subprocess, "run", side_effect=unavailable_daemon), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen):
            with self.assertRaisesRegex(helper.ControlHelperError, "Local Docker image inspection failed"):
                self._call()
        self.assertEqual(docker.popen_calls, [])

    def test_terminal_build_failure_is_not_resubmitted(self):
        docker = FakeDocker(build_exit=17)
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(helper.subprocess, "run", side_effect=docker.run), \
                patch.object(helper.subprocess, "Popen", side_effect=docker.popen):
            with self.assertRaises(helper.ControlHelperTerminalError) as caught:
                self._call()
        self.assertEqual(caught.exception.exit_code, 17)
        self.assertEqual(len(docker.popen_calls), 1)
        self.assertEqual(docker.processes[0].wait_calls, 1)


if __name__ == "__main__":
    unittest.main()
